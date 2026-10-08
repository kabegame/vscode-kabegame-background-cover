import * as vscode from 'vscode';
import * as os from 'os';
import * as crypto from 'crypto';
import { KabegameIpcClient, AlbumInfo, ImageInfo, rowToAlbumInfo, rowToImageInfo } from './KabegameIpcClient';

/** CBOR may decode >53-bit integers as BigInt; webview postMessage uses JSON.stringify which throws on BigInt. */
function sanitizeBigInt(val: unknown): unknown {
    if (typeof val === 'bigint') { return Number(val); }
    if (Array.isArray(val)) { return val.map(sanitizeBigInt); }
    if (val !== null && typeof val === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(val as object)) {
            out[k] = sanitizeBigInt(v);
        }
        return out;
    }
    return val;
}

const IMAGE_PAGE_SIZE = 100;
const ALBUM_PAGE_SIZE = 100;
const VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v|mkv)$/i;

/** 面包屑一项：`albumId` 为空表示首页（全部图片 + 根画册）。 */
interface BreadcrumbEntry { label: string; albumId?: string; }

/** 一个位置在 PathQL 上的查询路径：图片走 `images://gallery/hide/...`（排除隐藏图），画册按目录分页查 `albums://`。 */
function locationPaths(albumId?: string): { imageCount: string; imageList: string; albums: string } {
    if (albumId) {
        const id = encodeURIComponent(albumId);
        const images = `images://gallery/hide/album/${id}`;
        return { imageCount: images, imageList: images, albums: `albums://parent/${id}` };
    }
    // 首页最新优先
    return {
        imageCount: 'images://gallery/hide/all',
        imageList: 'images://gallery/hide/all/desc',
        albums: 'albums://roots',
    };
}

interface GalleryData {
    imageTotal: number;
    page: number;
    pageSize: number;
    images: ImageInfo[];
    albumTotal: number;
    albumPage: number;
    albumPageSize: number;
    albums: AlbumInfo[];
}

export class KabegameGalleryView implements vscode.WebviewViewProvider, vscode.Disposable {
    private _view?: vscode.WebviewView;
    private _breadcrumb: BreadcrumbEntry[] = [{ label: 'Home' }];
    /** 当前位置的图片页码。 */
    private _currentPage: number = 1;
    /** 当前位置的子画册页码。 */
    private _albumPage: number = 1;
    /** 丢弃过期的加载结果（快速翻页/切换位置时）。 */
    private _loadSeq: number = 0;
    private _disposables: vscode.Disposable[] = [];

    constructor(private readonly ipcClient: KabegameIpcClient) {
        this._disposables.push(
            ipcClient.onImagesChange(() => this.refresh()),
            ipcClient.onAlbumChange(() => this.refresh()),
            ipcClient.onConnectionChange((connected) => {
                this._view?.webview.postMessage({ type: 'connection-status', connected });
                if (connected) { this.refresh(); }
            }),
        );
    }

    dispose(): void {
        this._disposables.forEach(d => d.dispose());
        this._disposables = [];
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.file(os.homedir()),
                ...(process.env.APPDATA ? [vscode.Uri.file(process.env.APPDATA)] : []),
                ...(process.env.LOCALAPPDATA ? [vscode.Uri.file(process.env.LOCALAPPDATA)] : []),
                vscode.Uri.file(os.tmpdir()),
            ],
        };

        webviewView.webview.html = this.getHtml(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (msg: {
            type: string; imageId?: string; albumId?: string; name?: string;
            index?: number; page?: number; url?: string;
        }) => {
            switch (msg.type) {
                case 'ready':
                    // Always send current connection state so the webview initialises correctly
                    this._view?.webview.postMessage({
                        type: 'connection-status',
                        connected: this.ipcClient.isConnected,
                    });
                    if (this.ipcClient.isConnected) { this.refresh(); }
                    break;
                case 'open-album':
                    if (msg.albumId) {
                        this._breadcrumb.push({ label: msg.name || 'Album', albumId: msg.albumId });
                        this._currentPage = 1;
                        this._albumPage = 1;
                        this.refresh();
                    }
                    break;
                case 'page':
                    if (typeof msg.page === 'number') {
                        this._currentPage = Math.max(1, Math.floor(msg.page));
                        this.refresh();
                    }
                    break;
                case 'album-page':
                    if (typeof msg.page === 'number') {
                        this._albumPage = Math.max(1, Math.floor(msg.page));
                        this.refresh();
                    }
                    break;
                case 'navigate-crumb':
                    if (typeof msg.index === 'number') { this.navigateToCrumb(msg.index); }
                    break;
                case 'set-background':
                    if (msg.imageId) {
                        const syncEnabled = vscode.workspace
                            .getConfiguration('backgroundCover')
                            .get<boolean>('syncKabegame', true);
                        if (syncEnabled) {
                            const ok = await this.ipcClient.setCurrentWallpaperImageId(msg.imageId);
                            if (!ok && this._view) {
                                this._view.webview.postMessage({
                                    type: 'error',
                                    message: 'Failed to set wallpaper in Kabegame (IPC).',
                                });
                            }
                        } else {
                            const localPath = await this.ipcClient.getImageLocalPath(msg.imageId);
                            if (localPath) {
                                await vscode.workspace.getConfiguration().update(
                                    'backgroundCover.imagePath', localPath, vscode.ConfigurationTarget.Global
                                );
                            }
                        }
                    }
                    break;
                case 'open-url':
                    if (msg.url) { vscode.env.openExternal(vscode.Uri.parse(msg.url)); }
                    break;
            }
        });
    }

    home(): void {
        this._breadcrumb = [{ label: 'Home' }];
        this._currentPage = 1;
        this._albumPage = 1;
        this.refresh();
    }

    refresh(): void {
        void this.loadAndSend();
    }

    navigateToCrumb(index: number): void {
        if (index < 0 || index >= this._breadcrumb.length) { return; }
        this._breadcrumb = this._breadcrumb.slice(0, index + 1);
        this._currentPage = 1;
        this._albumPage = 1;
        this.refresh();
    }

    private async loadAndSend(): Promise<void> {
        if (!this._view || !this.ipcClient.isConnected) { return; }
        const seq = ++this._loadSeq;
        const albumId = this._breadcrumb[this._breadcrumb.length - 1].albumId;
        this._view.webview.postMessage({ type: 'loading', loading: true });
        try {
            const data = await this.fetchLocation(albumId);
            if (seq !== this._loadSeq || !this._view) { return; }
            // 越界页（例如删图后最后一页变空）收回到最后一页
            const lastPage = Math.max(1, Math.ceil(data.imageTotal / IMAGE_PAGE_SIZE));
            const lastAlbumPage = Math.max(1, Math.ceil(data.albumTotal / ALBUM_PAGE_SIZE));
            if (this._currentPage > lastPage || this._albumPage > lastAlbumPage) {
                this._currentPage = Math.min(this._currentPage, lastPage);
                this._albumPage = Math.min(this._albumPage, lastAlbumPage);
                return this.loadAndSend();
            }
            this._view.webview.postMessage({
                type: 'gallery-data',
                data: sanitizeBigInt(data),
                thumbnailUris: this.buildThumbnailUris(data.images),
                breadcrumb: this._breadcrumb.map(c => c.label),
            });
        } catch (e) {
            if (seq === this._loadSeq) {
                this._view?.webview.postMessage({ type: 'error', message: String(e) });
            }
        } finally {
            if (seq === this._loadSeq) {
                this._view?.webview.postMessage({ type: 'loading', loading: false });
            }
        }
    }

    private async fetchLocation(albumId?: string): Promise<GalleryData> {
        const paths = locationPaths(albumId);
        const page = this._currentPage;
        const albumPage = this._albumPage;
        const [imageEntry, imageRows, albumEntry, albumRows] = await Promise.all([
            this.ipcClient.pathqlEntry(paths.imageCount),
            this.ipcClient.pathqlFetch(`${paths.imageList}/x${IMAGE_PAGE_SIZE}x/${page}`),
            this.ipcClient.pathqlEntry(paths.albums),
            // `~~/images/hide` 在分页之后按画册 GROUP BY，给出子树（排除隐藏图）的图片数
            this.ipcClient.pathqlFetch(`${paths.albums}/x${ALBUM_PAGE_SIZE}x/${albumPage}/~~/images/hide`),
        ]);
        const images = imageRows.map(rowToImageInfo).filter(i => i.id);
        const albums = albumRows.map(rowToAlbumInfo).filter(a => a.id);
        return {
            imageTotal: Number(imageEntry?.total ?? images.length) || 0,
            page,
            pageSize: IMAGE_PAGE_SIZE,
            images,
            albumTotal: Number(albumEntry?.total ?? albums.length) || 0,
            albumPage,
            albumPageSize: ALBUM_PAGE_SIZE,
            albums,
        };
    }

    private buildThumbnailUris(images: ImageInfo[]): Record<string, string> {
        const uris: Record<string, string> = {};
        if (!this._view) { return uris; }
        for (const image of images) {
            const src = image.thumbnailPath || image.localPath;
            if (!src) { continue; }
            try {
                uris[image.id] = this._view.webview.asWebviewUri(vscode.Uri.file(src)).toString();
            } catch { /* skip */ }
        }
        return uris;
    }

    private getHtml(webview: vscode.Webview): string {
        const nonce = crypto.randomBytes(16).toString('hex');
        const csp = [
            `default-src 'none'`,
            `img-src ${webview.cspSource} data:`,
            `media-src ${webview.cspSource}`,
            `style-src 'unsafe-inline'`,
            `script-src 'nonce-${nonce}'`,
        ].join('; ');

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Kabegame Gallery</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); }
#toolbar { display: flex; align-items: center; padding: 4px 8px; border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border); min-height: 28px; }
#breadcrumb { display: flex; align-items: center; flex-wrap: wrap; gap: 2px; flex: 1; min-width: 0; font-size: 11px; }
.crumb { cursor: pointer; color: var(--vscode-textLink-foreground); white-space: nowrap; max-width: 120px; overflow: hidden; text-overflow: ellipsis; }
.crumb:hover { text-decoration: underline; }
.crumb-current { cursor: default; color: var(--vscode-foreground); white-space: nowrap; max-width: 120px; overflow: hidden; text-overflow: ellipsis; }
.crumb-sep { color: var(--vscode-descriptionForeground); }
#status { font-size: 11px; padding: 2px 8px; height: 18px; }
#status.loading { color: var(--vscode-descriptionForeground); }
#disconnected-panel { display: none; padding: 32px 16px; text-align: center; flex-direction: column; align-items: center; gap: 6px; }
.dc-icon { font-size: 36px; line-height: 1; }
.dc-title { font-weight: 600; font-size: 13px; margin-top: 4px; }
.dc-desc { font-size: 11px; color: var(--vscode-descriptionForeground); max-width: 200px; }
#dc-download-btn { margin-top: 8px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 5px 14px; border-radius: 3px; cursor: pointer; font-size: 12px; }
#dc-download-btn:hover { background: var(--vscode-button-hoverBackground); }
#gallery { padding: 6px 4px; }
.section-label { font-size: 11px; color: var(--vscode-descriptionForeground); padding: 4px 4px 2px; text-transform: uppercase; letter-spacing: 0.05em; }
.album-thumb { width: 40px; height: 28px; object-fit: cover; border-radius: 2px; flex-shrink: 0; background: var(--vscode-editor-background); }
.albums-row { display: flex; flex-wrap: wrap; gap: 6px; padding: 2px 4px 6px; }
.album-card { display: flex; align-items: center; gap: 6px; padding: 4px 8px; border: 1px solid var(--vscode-sideBarSectionHeader-border); border-radius: 4px; cursor: pointer; background: var(--vscode-list-hoverBackground); font-size: 12px; }
.album-card:hover { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.album-icon { font-size: 14px; }
.album-name { font-weight: 500; }
.album-count { font-size: 10px; color: var(--vscode-descriptionForeground); }
.image-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 4px; padding: 2px 4px; }
.image-card { position: relative; aspect-ratio: 16/9; overflow: hidden; cursor: pointer; border-radius: 3px; background: var(--vscode-editor-background); border: 2px solid transparent; }
.image-card:hover { border-color: var(--vscode-focusBorder); }
.image-card img, .image-card video { width: 100%; height: 100%; object-fit: cover; display: block; }
.image-card .placeholder { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; font-size: 20px; color: var(--vscode-descriptionForeground); }
.pagination { display: flex; align-items: center; justify-content: center; gap: 6px; padding: 8px 4px; font-size: 12px; flex-wrap: wrap; }
.page-btn { background: none; border: 1px solid var(--vscode-button-secondaryBackground); color: var(--vscode-foreground); padding: 2px 10px; cursor: pointer; border-radius: 3px; }
.page-btn:disabled { opacity: 0.4; cursor: default; }
.page-input { width: 48px; text-align: center; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-sideBarSectionHeader-border)); border-radius: 3px; padding: 2px 4px; font-size: 12px; }
.more-msg { font-size: 11px; color: var(--vscode-descriptionForeground); padding: 0 4px 6px; }
.error-msg { padding: 12px 8px; color: var(--vscode-errorForeground); font-size: 12px; }
.empty-msg { padding: 24px 8px; text-align: center; color: var(--vscode-descriptionForeground); font-size: 12px; }
</style>
</head>
<body>
<div id="toolbar">
  <div id="breadcrumb"><span class="crumb-current">Home</span></div>
</div>
<div id="status"></div>
<div id="disconnected-panel">
  <div class="dc-icon">&#127918;</div>
  <div class="dc-title">Kabegame not running</div>
  <div class="dc-desc">Start Kabegame to browse your wallpaper gallery</div>
  <button id="dc-download-btn">Download from GitHub</button>
</div>
<div id="gallery"></div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const VIDEO_EXT_RE = ${VIDEO_EXT_RE.toString()};
let thumbnailUris = {};

const gallery = document.getElementById('gallery');
const statusEl = document.getElementById('status');
const breadcrumbEl = document.getElementById('breadcrumb');
const disconnectedPanel = document.getElementById('disconnected-panel');

document.getElementById('dc-download-btn').addEventListener('click', () => {
    vscode.postMessage({ type: 'open-url', url: 'https://github.com/kabegame/kabegame' });
});

window.addEventListener('message', event => {
    const msg = event.data;
    switch (msg.type) {
        case 'connection-status':
            setConnected(msg.connected);
            break;
        case 'loading':
            if (msg.loading) {
                statusEl.textContent = 'Loading...';
                statusEl.className = 'loading';
            } else {
                statusEl.textContent = '';
                statusEl.className = '';
            }
            break;
        case 'gallery-data':
            thumbnailUris = msg.thumbnailUris || {};
            renderBreadcrumb(msg.breadcrumb || ['Home']);
            renderGallery(msg.data);
            break;
        case 'error':
            gallery.innerHTML = '<div class="error-msg">Error: ' + escHtml(msg.message) + '</div>';
            break;
    }
});

function setConnected(connected) {
    if (connected) {
        disconnectedPanel.style.display = 'none';
        gallery.style.display = '';
        statusEl.style.display = '';
    } else {
        disconnectedPanel.style.display = 'flex';
        gallery.style.display = 'none';
        statusEl.style.display = 'none';
        gallery.innerHTML = '';
    }
}

function renderBreadcrumb(labels) {
    breadcrumbEl.innerHTML = '';
    labels.forEach(function(label, index) {
        if (index > 0) {
            var sep = document.createElement('span');
            sep.className = 'crumb-sep';
            sep.textContent = ' \u203a ';
            breadcrumbEl.appendChild(sep);
        }
        var el = document.createElement('span');
        var isCurrent = index === labels.length - 1;
        el.className = isCurrent ? 'crumb-current' : 'crumb';
        el.title = label;
        el.textContent = label;
        if (!isCurrent) {
            el.addEventListener('click', function() {
                vscode.postMessage({ type: 'navigate-crumb', index: index });
            });
        }
        breadcrumbEl.appendChild(el);
    });
}

function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/** 分页条；kind 为 'page'（图片）或 'album-page'（子画册）。 */
function paginationHtml(kind, page, totalPages, withJump) {
    if (totalPages <= 1) { return ''; }
    var html = '<div class="pagination">'
        + '<button class="page-btn" ' + (page <= 1 ? 'disabled' : 'data-' + kind + '="' + (page - 1) + '"') + '>&#8249;</button>'
        + '<span>Page ' + page + ' / ' + totalPages + '</span>'
        + '<button class="page-btn" ' + (page >= totalPages ? 'disabled' : 'data-' + kind + '="' + (page + 1) + '"') + '>&#8250;</button>';
    if (withJump) {
        html += '<input type="number" class="page-input" id="page-jump" min="1" max="' + totalPages + '" value="' + page + '">'
            + '<button class="page-btn" id="jump-btn">Go</button>';
    }
    return html + '</div>';
}

function renderGallery(data) {
    if (!data) { gallery.innerHTML = '<div class="empty-msg">No results.</div>'; return; }
    var albums = data.albums || [];
    var images = data.images || [];
    var html = '';

    if (albums.length > 0) {
        var albumPages = Math.max(1, Math.ceil(data.albumTotal / data.albumPageSize));
        html += '<div class="section-label">Albums (' + data.albumTotal + ')</div><div class="albums-row">';
        albums.forEach(function(a) {
            var countHtml = a.imageCount > 0
                ? '<div class="album-count">' + a.imageCount + ' images</div>'
                : '';
            html += '<div class="album-card" data-album-id="' + escHtml(a.id) + '" data-album-name="' + escHtml(a.name) + '">'
                + '<span class="album-icon">' + (a.type === 'label_dir' ? '&#128193;' : '&#128447;') + '</span>'
                + '<span><div class="album-name">' + escHtml(a.name) + '</div>'
                + countHtml + '</span></div>';
        });
        html += '</div>';
        html += paginationHtml('album-page', data.albumPage, albumPages, false);
    }

    var totalPages = Math.max(1, Math.ceil(data.imageTotal / data.pageSize));
    if (images.length > 0) {
        html += '<div class="section-label">Images (' + data.imageTotal + ')</div><div class="image-grid">';
        images.forEach(function(img) {
            var uri = thumbnailUris[img.id];
            var inner;
            if (!uri) {
                inner = '<div class="placeholder">&#128444;</div>';
            } else if (VIDEO_EXT_RE.test(img.thumbnailPath || img.localPath || '')) {
                // 桌面端视频预览图是 MP4，<img> 显示不了
                inner = '<video src="' + escHtml(uri) + '" muted loop preload="metadata"></video>';
            } else {
                inner = '<img src="' + escHtml(uri) + '" loading="lazy" alt="">';
            }
            html += '<div class="image-card" data-id="' + escHtml(img.id) + '">' + inner + '</div>';
        });
        html += '</div>';
        html += paginationHtml('page', data.page, totalPages, true);
    }

    if (!albums.length && !images.length) {
        html = '<div class="empty-msg">No images found.</div>';
    }

    gallery.innerHTML = html;

    gallery.querySelectorAll('[data-album-id]').forEach(function(el) {
        el.addEventListener('click', function() {
            vscode.postMessage({
                type: 'open-album',
                albumId: el.getAttribute('data-album-id'),
                name: el.getAttribute('data-album-name'),
            });
        });
    });
    gallery.querySelectorAll('[data-page]').forEach(function(el) {
        el.addEventListener('click', function() {
            vscode.postMessage({ type: 'page', page: Number(el.getAttribute('data-page')) });
        });
    });
    gallery.querySelectorAll('[data-album-page]').forEach(function(el) {
        el.addEventListener('click', function() {
            vscode.postMessage({ type: 'album-page', page: Number(el.getAttribute('data-album-page')) });
        });
    });
    gallery.querySelectorAll('.image-card[data-id]').forEach(function(el) {
        el.addEventListener('click', function() {
            var imageId = el.getAttribute('data-id');
            if (imageId) { vscode.postMessage({ type: 'set-background', imageId: imageId }); }
        });
        var video = el.querySelector('video');
        if (video) {
            el.addEventListener('mouseenter', function() { video.play().catch(function() {}); });
            el.addEventListener('mouseleave', function() { video.pause(); });
        }
    });

    var jumpBtn = gallery.querySelector('#jump-btn');
    if (jumpBtn) {
        jumpBtn.addEventListener('click', function() {
            var input = gallery.querySelector('#page-jump');
            var page = Math.max(1, Math.min(parseInt(input ? input.value : '1') || 1, totalPages));
            vscode.postMessage({ type: 'page', page: page });
        });
        var jumpInput = gallery.querySelector('#page-jump');
        if (jumpInput) {
            jumpInput.addEventListener('keydown', function(e) {
                if (e.key === 'Enter') { jumpBtn.click(); }
            });
        }
    }
}

vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
    }
}
