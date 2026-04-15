import * as vscode from 'vscode';
import * as os from 'os';
import * as crypto from 'crypto';
import { KabegameIpcClient, GalleryBrowseEntry, GalleryBrowseResult, StorageAlbum } from './KabegameIpcClient';

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

/** Split "album/abc/3" → { basePath: "album/abc", page: 3 }. */
function parsePath(path: string): { basePath: string; page: number } {
    const m = path.match(/^(.*?)\/(\d+)$/);
    return m ? { basePath: m[1], page: parseInt(m[2]) || 1 } : { basePath: path, page: 1 };
}

/** Breadcrumb entry — stores location only, never a page number. */
interface BreadcrumbEntry { label: string; basePath: string; }

export class KabegameGalleryView implements vscode.WebviewViewProvider, vscode.Disposable {
    private _view?: vscode.WebviewView;
    /** Location stack — each entry is an album/root location, no page. */
    private _breadcrumb: BreadcrumbEntry[] = [{ label: 'Home', basePath: 'all' }];
    /** Current page within the top-most breadcrumb location. */
    private _currentPage: number = 1;
    private _albumById: Map<string, StorageAlbum> = new Map();
    private _albumChildren: Map<string | null, StorageAlbum[]> = new Map();
    private _pageSize: number = 100;
    private _disposables: vscode.Disposable[] = [];

    constructor(private readonly ipcClient: KabegameIpcClient) {
        this._disposables.push(
            ipcClient.onImagesChange(() => this.refresh()),
            ipcClient.onAlbumChange(async () => {
                await this.refreshAlbumTree();
                this.refresh();
            }),
            ipcClient.onConnectionChange((connected) => {
                this._view?.webview.postMessage({ type: 'connection-status', connected });
                if (connected) {
                    // Load gallery immediately — do not block on album tree or page size
                    this.loadAndSend(this.currentFullPath());
                    // Fetch metadata in background; re-render once both complete
                    Promise.all([
                        this.refreshAlbumTree(),
                        this.ipcClient.getGalleryPageSize().then(ps => { this._pageSize = ps; }),
                    ]).then(() => {
                        this.loadAndSend(this.currentFullPath());
                    }).catch(() => { /* ignore — old daemon may not support these commands */ });
                }
            }),
            ipcClient.onSettingChange((changes) => {
                if ('galleryPageSize' in changes) {
                    const n = Number(changes['galleryPageSize']);
                    if ([100, 500, 1000].includes(n)) { this._pageSize = n; }
                }
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
            type: string; path?: string; imageId?: string; index?: number; url?: string;
        }) => {
            switch (msg.type) {
                case 'ready':
                    // Always send current connection state so the webview initialises correctly
                    this._view?.webview.postMessage({
                        type: 'connection-status',
                        connected: this.ipcClient.isConnected,
                    });
                    if (this.ipcClient.isConnected) {
                        this.loadAndSend(this.currentFullPath());
                    }
                    break;
                case 'navigate':
                    if (msg.path) { await this.navigate(msg.path); }
                    break;
                case 'navigate-crumb':
                    if (typeof msg.index === 'number') { await this.navigateToCrumb(msg.index); }
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
        this._breadcrumb = [{ label: 'Home', basePath: 'all' }];
        this._currentPage = 1;
        this.loadAndSend('all/1');
    }

    refresh(): void {
        this.loadAndSend(this.currentFullPath());
    }

    /** Navigate to a provider path from the webview (page change or new location). */
    async navigate(providerPath: string): Promise<void> {
        const { basePath, page } = parsePath(providerPath);
        const currentBase = this._breadcrumb[this._breadcrumb.length - 1].basePath;

        if (basePath === currentBase) {
            // Same location, just a page change — update page, no new breadcrumb entry
            this._currentPage = page;
        } else {
            // New location (entering an album or going back to root) — push breadcrumb
            const albumMatch = basePath.match(/^album\/([^/]+)$/);
            const label = albumMatch
                ? (this._albumById.get(albumMatch[1])?.name ?? 'Album')
                : 'Home';
            this._breadcrumb.push({ label, basePath });
            this._currentPage = 1;
        }
        await this.loadAndSend(this.currentFullPath());
    }

    async navigateToCrumb(index: number): Promise<void> {
        if (index < 0 || index >= this._breadcrumb.length) { return; }
        this._breadcrumb = this._breadcrumb.slice(0, index + 1);
        this._currentPage = 1;
        await this.loadAndSend(this.currentFullPath());
    }

    /** Returns the full provider path for the current location + page. */
    private currentFullPath(): string {
        return this._breadcrumb[this._breadcrumb.length - 1].basePath + '/' + this._currentPage;
    }

    private async refreshAlbumTree(): Promise<void> {
        const albums = await this.ipcClient.getAlbums();
        this._albumById.clear();
        this._albumChildren.clear();
        for (const a of albums) {
            this._albumById.set(a.id, a);
            const parentKey: string | null = a.parentId ?? null;
            if (!this._albumChildren.has(parentKey)) { this._albumChildren.set(parentKey, []); }
            this._albumChildren.get(parentKey)!.push(a);
        }
    }

    private async loadAndSend(providerPath: string): Promise<void> {
        if (!this._view) { return; }
        this._view.webview.postMessage({ type: 'loading', loading: true });
        try {
            const raw = await this.ipcClient.galleryBrowse(providerPath);
            const result: GalleryBrowseResult = raw ?? { total: 0, baseOffset: 0, rangeTotal: 0, entries: [] };
            if (!Array.isArray(result.entries)) { result.entries = []; }

            // Inject child albums from the in-memory tree (no extra IPC call)
            // basePath for current location: "all" → root albums (null key), "album/id" → children of id
            const { basePath } = parsePath(providerPath);
            const albumParentMatch = basePath.match(/^album\/([^/]+)$/);
            const parentKey: string | null = albumParentMatch ? albumParentMatch[1] : null;
            const childAlbums = this._albumChildren.get(parentKey) ?? [];
            const albumEntries: GalleryBrowseEntry[] = childAlbums.map(a => ({
                kind: 'album' as const,
                album: { id: a.id, name: a.name, imageCount: 0, previewImages: [] },
            }));
            result.entries = [...albumEntries, ...result.entries];

            // Empty page redirect: if non-album entries are absent but total > 0, go to page 1
            const nonAlbumCount = result.entries.filter(e => e.kind !== 'album').length;
            if (nonAlbumCount === 0 && result.total > 0 && this._currentPage !== 1) {
                this._currentPage = 1;
                return this.loadAndSend(this.currentFullPath());
            }

            const thumbnailUris = this.buildThumbnailUris(result);
            const safeResult = sanitizeBigInt(result) as GalleryBrowseResult;
            this._view.webview.postMessage({
                type: 'gallery-data',
                path: providerPath,
                result: safeResult,
                thumbnailUris,
                breadcrumb: this._breadcrumb,
                pageSize: this._pageSize,
            });
        } catch (e) {
            this._view.webview.postMessage({ type: 'error', message: String(e) });
        } finally {
            this._view?.webview.postMessage({ type: 'loading', loading: false });
        }
    }

    private buildThumbnailUris(result: GalleryBrowseResult): Record<string, string> {
        const uris: Record<string, string> = {};
        if (!this._view) { return uris; }
        for (const entry of result.entries) {
            if (entry.kind === 'image') {
                const src = entry.image.thumbnailPath || entry.image.localPath;
                if (src) {
                    try {
                        uris[entry.image.id] = this._view.webview.asWebviewUri(
                            vscode.Uri.file(src)
                        ).toString();
                    } catch { /* skip */ }
                }
            } else if (entry.kind === 'album' && entry.album.previewImages && entry.album.previewImages.length > 0) {
                const src = entry.album.previewImages[0].thumbnailPath || entry.album.previewImages[0].localPath;
                if (src) {
                    try {
                        uris['album-' + entry.album.id] = this._view.webview.asWebviewUri(
                            vscode.Uri.file(src)
                        ).toString();
                    } catch { /* skip */ }
                }
            }
        }
        return uris;
    }

    private getHtml(webview: vscode.Webview): string {
        const nonce = crypto.randomBytes(16).toString('hex');
        const csp = [
            `default-src 'none'`,
            `img-src ${webview.cspSource} data:`,
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
.dirs-row { display: flex; flex-wrap: wrap; gap: 4px; padding: 2px 4px 6px; }
.dir-card { display: flex; align-items: center; gap: 6px; padding: 4px 8px; border: 1px solid var(--vscode-sideBarSectionHeader-border); border-radius: 4px; cursor: pointer; background: var(--vscode-list-hoverBackground); font-size: 12px; min-width: 80px; }
.dir-card:hover { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.dir-icon { font-size: 14px; }
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
.image-card img { width: 100%; height: 100%; object-fit: cover; display: block; }
.image-card .placeholder { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; font-size: 20px; color: var(--vscode-descriptionForeground); }
.pagination { display: flex; align-items: center; justify-content: center; gap: 6px; padding: 8px 4px; font-size: 12px; flex-wrap: wrap; }
.page-btn { background: none; border: 1px solid var(--vscode-button-secondaryBackground); color: var(--vscode-foreground); padding: 2px 10px; cursor: pointer; border-radius: 3px; }
.page-btn:disabled { opacity: 0.4; cursor: default; }
.page-input { width: 48px; text-align: center; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-sideBarSectionHeader-border)); border-radius: 3px; padding: 2px 4px; font-size: 12px; }
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
let currentResult = null;
let currentPath = 'all/1';
let currentBreadcrumb = [{ label: 'Home', basePath: 'all' }];
let thumbnailUris = {};
let pageSize = 100;

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
            currentResult = msg.result;
            currentPath = msg.path;
            thumbnailUris = msg.thumbnailUris || {};
            currentBreadcrumb = msg.breadcrumb || currentBreadcrumb;
            pageSize = msg.pageSize || 100;
            renderBreadcrumb(currentBreadcrumb);
            renderGallery(msg.result);
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

function renderBreadcrumb(crumbs) {
    breadcrumbEl.innerHTML = '';
    crumbs.forEach(function(crumb, index) {
        if (index > 0) {
            var sep = document.createElement('span');
            sep.className = 'crumb-sep';
            sep.textContent = ' \u203a ';
            breadcrumbEl.appendChild(sep);
        }
        var el = document.createElement('span');
        var isCurrent = index === crumbs.length - 1;
        el.className = isCurrent ? 'crumb-current' : 'crumb';
        el.title = crumb.label;
        el.textContent = crumb.label;
        if (!isCurrent) {
            (function(i) {
                el.addEventListener('click', function() {
                    vscode.postMessage({ type: 'navigate-crumb', index: i });
                });
            })(index);
        }
        breadcrumbEl.appendChild(el);
    });
}

function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function renderGallery(result) {
    if (!result) { gallery.innerHTML = '<div class="empty-msg">No results.</div>'; return; }
    var entries = result.entries || [];

    var dirs = entries.filter(function(e) { return e.kind === 'dir'; });
    var albums = entries.filter(function(e) { return e.kind === 'album'; });
    var images = entries.filter(function(e) { return e.kind === 'image'; });

    var html = '';

    if (dirs.length > 0) {
        html += '<div class="section-label">Folders</div><div class="dirs-row">';
        dirs.forEach(function(e) {
            html += '<div class="dir-card" data-nav="' + escHtml(buildSubPath(currentPath, e.name)) + '">'
                + '<span class="dir-icon">&#128193;</span>'
                + '<span>' + escHtml(e.name) + '</span></div>';
        });
        html += '</div>';
    }

    if (albums.length > 0) {
        html += '<div class="section-label">Albums</div><div class="albums-row">';
        albums.forEach(function(e) {
            var a = e.album;
            var thumbUri = thumbnailUris['album-' + a.id];
            var thumbHtml = thumbUri
                ? '<img class="album-thumb" src="' + escHtml(thumbUri) + '" alt="">'
                : '<span class="album-icon">&#128447;</span>';
            var countHtml = a.imageCount > 0
                ? '<div class="album-count">' + a.imageCount + ' images</div>'
                : '';
            html += '<div class="album-card" data-nav="album/' + escHtml(a.id) + '/1">'
                + thumbHtml
                + '<span><div class="album-name">' + escHtml(a.name) + '</div>'
                + countHtml + '</span></div>';
        });
        html += '</div>';
    }

    var totalPages = 1;
    if (images.length > 0) {
        var pageNum = extractPageNum(currentPath);
        totalPages = Math.max(1, Math.ceil(result.total / pageSize));
        html += '<div class="section-label">Images (' + result.total + ')</div><div class="image-grid">';
        images.forEach(function(e) {
            var img = e.image;
            var uri = thumbnailUris[img.id];
            if (uri) {
                html += '<div class="image-card" data-id="' + escHtml(img.id) + '">'
                    + '<img src="' + escHtml(uri) + '" loading="lazy" alt="">'
                    + '</div>';
            } else {
                html += '<div class="image-card" data-id="' + escHtml(img.id) + '">'
                    + '<div class="placeholder">&#128444;</div>'
                    + '</div>';
            }
        });
        html += '</div>';

        if (totalPages > 1) {
            var prevPath = buildPagePath(currentPath, pageNum - 1);
            var nextPath = buildPagePath(currentPath, pageNum + 1);
            html += '<div class="pagination">'
                + '<button class="page-btn" ' + (pageNum <= 1 ? 'disabled' : 'data-nav="' + escHtml(prevPath) + '"') + '>&#8249;</button>'
                + '<span>Page ' + pageNum + ' / ' + totalPages + '</span>'
                + '<button class="page-btn" ' + (pageNum >= totalPages ? 'disabled' : 'data-nav="' + escHtml(nextPath) + '"') + '>&#8250;</button>'
                + '<input type="number" class="page-input" id="page-jump" min="1" max="' + totalPages + '" value="' + pageNum + '">'
                + '<button class="page-btn" id="jump-btn">Go</button>'
                + '</div>';
        }
    }

    if (!dirs.length && !albums.length && !images.length) {
        html = '<div class="empty-msg">No images found.</div>';
    }

    gallery.innerHTML = html;

    gallery.querySelectorAll('[data-nav]').forEach(function(el) {
        el.addEventListener('click', function() {
            var navPath = el.getAttribute('data-nav');
            if (navPath) { vscode.postMessage({ type: 'navigate', path: navPath }); }
        });
    });
    gallery.querySelectorAll('.image-card[data-id]').forEach(function(el) {
        el.addEventListener('click', function() {
            var imageId = el.getAttribute('data-id');
            if (imageId) { vscode.postMessage({ type: 'set-background', imageId: imageId }); }
        });
    });

    var jumpBtn = gallery.querySelector('#jump-btn');
    if (jumpBtn) {
        var tp = totalPages;
        jumpBtn.addEventListener('click', function() {
            var input = gallery.querySelector('#page-jump');
            var page = Math.max(1, Math.min(parseInt(input ? input.value : '1') || 1, tp));
            vscode.postMessage({ type: 'navigate', path: buildPagePath(currentPath, page) });
        });
        var jumpInput = gallery.querySelector('#page-jump');
        if (jumpInput) {
            jumpInput.addEventListener('keydown', function(e) {
                if (e.key === 'Enter') { jumpBtn.click(); }
            });
        }
    }
}

function extractPageNum(p) {
    var m = p.match(/(\\d+)$/);
    return m ? (parseInt(m[1]) || 1) : 1;
}

function buildSubPath(currentP, name) {
    var base = currentP.replace(/\\/[0-9]+$/, '');
    return base + '/' + name + '/1';
}

function buildPagePath(currentP, page) {
    return currentP.replace(/[0-9]+$/, String(Math.max(1, page)));
}

vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
    }
}
