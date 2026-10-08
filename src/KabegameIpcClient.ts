import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { encode, decode } = require('cbor-x');

// ---- Types ----

export interface ImageInfo {
    id: string;
    localPath: string;
    thumbnailPath?: string;
    /** 格式键，例如 `image/jpg`、`video/mp4`。 */
    type?: string;
}

export interface AlbumInfo {
    id: string;
    name: string;
    /** `normal` / `label_dir` / `label` / `local_folder` 等。 */
    type: string;
    imageCount: number;
}

/** PathQL 节点自身；`total` 为该节点下的行总数（可能缺省）。 */
export interface PathqlEntry {
    name: string;
    total?: number | null;
}

type Row = Record<string, unknown>;

function rowString(row: Row, key: string): string | undefined {
    const v = row[key];
    if (typeof v === 'string') { return v; }
    if (typeof v === 'number' || typeof v === 'bigint') { return String(v); }
    return undefined;
}

function rowNumber(row: Row, key: string): number {
    const n = Number(row[key]);
    return Number.isFinite(n) ? n : 0;
}

export function rowToImageInfo(row: Row): ImageInfo {
    return {
        id: rowString(row, 'id') ?? '',
        localPath: rowString(row, 'local_path') ?? '',
        thumbnailPath: rowString(row, 'thumbnail_path'),
        type: rowString(row, 'type'),
    };
}

export function rowToAlbumInfo(row: Row): AlbumInfo {
    return {
        id: rowString(row, 'id') ?? '',
        name: rowString(row, 'name') ?? '',
        type: rowString(row, 'type') ?? 'normal',
        imageCount: rowNumber(row, 'image_count'),
    };
}

// ---- IPC Client ----

const WINDOWS_PIPE = '\\\\.\\pipe\\kabegame-app';
const UNIX_SOCKET = () => path.join(os.tmpdir(), 'Kabegame', 'kabegame.sock');

const SUBSCRIBE_KINDS = [
    'setting-change',
    'images-change',
    'album-images-change',
    'album-added',
    'album-changed',
    'album-deleted',
    'app-shutdown',
];

const BACKOFF_STEPS = [1000, 2000, 4000, 8000, 16000, 30000];

interface PendingRequest {
    resolve: (data: unknown) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

export class KabegameIpcClient implements vscode.Disposable {
    private socket: net.Socket | null = null;
    private accumulator = Buffer.alloc(0);
    private nextRequestId = 2; // 1 reserved for subscribe-events
    private pending = new Map<number, PendingRequest>();
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private backoffIndex = 0;
    private connectTime = 0;
    private disposed = false;
    private connected = false;

    private readonly _onSettingChange = new vscode.EventEmitter<Record<string, unknown>>();
    readonly onSettingChange = this._onSettingChange.event;

    private readonly _onImagesChange = new vscode.EventEmitter<void>();
    readonly onImagesChange = this._onImagesChange.event;

    private readonly _onAlbumChange = new vscode.EventEmitter<void>();
    readonly onAlbumChange = this._onAlbumChange.event;

    private readonly _onConnectionChange = new vscode.EventEmitter<boolean>();
    readonly onConnectionChange = this._onConnectionChange.event;

    get isConnected(): boolean { return this.connected; }

    connect(): void {
        if (this.disposed) { return; }
        this.scheduleReconnect(0);
    }

    dispose(): void {
        this.disposed = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.destroySocket();
        this._onSettingChange.dispose();
        this._onImagesChange.dispose();
        this._onAlbumChange.dispose();
        this._onConnectionChange.dispose();
    }

    async request(cmd: string, extra?: object): Promise<unknown> {
        return new Promise((resolve, reject) => {
            if (!this.socket || !this.connected) {
                reject(new Error('Not connected to Kabegame'));
                return;
            }
            const requestId = this.nextRequestId++;
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                reject(new Error(`IPC request "${cmd}" timed out`));
            }, 10000);
            this.pending.set(requestId, { resolve, reject, timer });
            try {
                this.writeFrame({ cmd, request_id: requestId, ...extra });
            } catch (e) {
                clearTimeout(timer);
                this.pending.delete(requestId);
                reject(e);
            }
        });
    }

    /** 拉取 PathQL 数据行（`images://...` / `albums://...`）。 */
    async pathqlFetch(path: string): Promise<Row[]> {
        const resp = await this.request('pathql-fetch', { path });
        return Array.isArray(resp) ? resp as Row[] : [];
    }

    /** 查询 PathQL 节点自身，主要用来取 `total`。 */
    async pathqlEntry(path: string): Promise<PathqlEntry | null> {
        const resp = await this.request('pathql-entry', { path });
        return resp && typeof resp === 'object' ? resp as PathqlEntry : null;
    }

    /** 按 id 取图片本地路径；与主程序前端 `fetchImageById` 走同一个 `gallery/by_id` provider。 */
    async getImageLocalPath(imageId: string): Promise<string | null> {
        const id = imageId.trim();
        if (!id) { return null; }
        try {
            const rows = await this.pathqlFetch(`images://gallery/by_id/${encodeURIComponent(id)}`);
            const localPath = rows[0] ? rowToImageInfo(rows[0]).localPath : '';
            return localPath || null;
        } catch {
            return null;
        }
    }

    /** Sets Kabegame current wallpaper by image id; daemon emits setting-change → extension resolves path. */
    async setCurrentWallpaperImageId(imageId: string): Promise<boolean> {
        const id = imageId.trim();
        if (!id) { return false; }
        try {
            await this.request('settings-set-current-wallpaper-image-id', { image_id: id });
            return true;
        } catch {
            return false;
        }
    }

    // ---- Private ----

    private scheduleReconnect(delay: number): void {
        if (this.disposed) { return; }
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); }
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.doConnect();
        }, delay);
    }

    private doConnect(): void {
        if (this.disposed) { return; }
        this.destroySocket();
        this.accumulator = Buffer.alloc(0);

        const socketPath = process.platform === 'win32' ? WINDOWS_PIPE : UNIX_SOCKET();
        const sock = net.createConnection({ path: socketPath });
        this.socket = sock;

        sock.on('connect', () => {
            this.connectTime = Date.now();
            this.connected = true;
            this.backoffIndex = 0;
            this._onConnectionChange.fire(true);
            this.onConnected();
        });

        sock.on('data', (chunk: Buffer) => {
            this.onData(chunk);
        });

        sock.on('close', () => {
            this.onDisconnected();
        });

        sock.on('error', (_err: Error) => {
            // error is always followed by close; handle in close handler
        });
    }

    private destroySocket(): void {
        if (this.socket) {
            this.socket.removeAllListeners();
            this.socket.destroy();
            this.socket = null;
        }
        // Reject all pending requests
        for (const [, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.reject(new Error('Connection closed'));
        }
        this.pending.clear();
    }

    private onConnected(): void {
        // 1. Subscribe to events
        this.writeFrame({
            cmd: 'subscribe-events',
            request_id: 1,
            kinds: SUBSCRIBE_KINDS,
        });

        // 2. Get current wallpaper image id, then resolve local path
        this.request('settings-get-current-wallpaper-image-id').then(async (imageId) => {
            if (typeof imageId === 'string' && imageId) {
                // Fire as a synthetic setting-change so extension.ts can handle it uniformly
                this._onSettingChange.fire({ currentWallpaperImageId: imageId });
            }
        }).catch(() => { /* ignore */ });

        // 3. 视频播放速度只在变化时才有 setting-change，连上时先取一次当前值
        this.request('settings-get-wallpaper-video-playback-rate').then((rate) => {
            const n = Number(rate);
            if (Number.isFinite(n)) {
                this._onSettingChange.fire({ wallpaperVideoPlaybackRate: n });
            }
        }).catch(() => { /* ignore */ });
    }

    private onDisconnected(): void {
        const wasConnected = this.connected;
        this.connected = false;
        this.destroySocket();
        if (wasConnected) {
            this._onConnectionChange.fire(false);
        }
        if (!this.disposed) {
            // If connection was stable for > 5s, reset backoff
            if (wasConnected && Date.now() - this.connectTime > 5000) {
                this.backoffIndex = 0;
            }
            const delay = BACKOFF_STEPS[Math.min(this.backoffIndex, BACKOFF_STEPS.length - 1)];
            this.backoffIndex = Math.min(this.backoffIndex + 1, BACKOFF_STEPS.length - 1);
            this.scheduleReconnect(delay);
        }
    }

    private onData(chunk: Buffer): void {
        this.accumulator = Buffer.concat([this.accumulator, chunk]);
        while (this.accumulator.length >= 4) {
            const frameLen = this.accumulator.readUInt32LE(0);
            if (this.accumulator.length < 4 + frameLen) { break; }
            const payload = this.accumulator.slice(4, 4 + frameLen);
            this.accumulator = this.accumulator.slice(4 + frameLen);
            try {
                const frame = decode(payload);
                this.onFrame(frame);
            } catch (e) {
                console.error('[KabegameIpc] CBOR decode error', e);
            }
        }
    }

    private onFrame(frame: unknown): void {
        if (!frame || typeof frame !== 'object') { return; }
        const f = frame as Record<string, unknown>;

        if ('type' in f) {
            // Event pushed by server
            this.onEvent(f);
        } else {
            // Response to a request
            const requestId = (f['request-id'] ?? f['request_id']) as number | undefined;
            if (requestId !== undefined) {
                const pending = this.pending.get(Number(requestId));
                if (pending) {
                    clearTimeout(pending.timer);
                    this.pending.delete(Number(requestId));
                    const ok = f['ok'];
                    if (ok === false) {
                        pending.reject(new Error(String(f['message'] ?? 'IPC error')));
                    } else {
                        pending.resolve(f['data']);
                    }
                }
            }
        }
    }

    private onEvent(f: Record<string, unknown>): void {
        const type = f['type'] as string;
        switch (type) {
            case 'setting-change': {
                const changes = f['changes'] as Record<string, unknown> | undefined;
                if (changes) {
                    this._onSettingChange.fire(changes);
                }
                break;
            }
            case 'images-change':
            case 'album-images-change':
                this._onImagesChange.fire();
                break;
            case 'album-added':
            case 'album-changed':
            case 'album-deleted':
                this._onAlbumChange.fire();
                break;
            case 'app-shutdown':
                this.onDisconnected();
                break;
        }
    }

    private writeFrame(obj: unknown): void {
        if (!this.socket) { return; }
        const payload = Buffer.from(encode(obj));
        const header = Buffer.allocUnsafe(4);
        header.writeUInt32LE(payload.length, 0);
        this.socket.write(Buffer.concat([header, payload]));
    }
}
