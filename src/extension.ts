'use strict';
import {
    commands,
    window,
    Extension,
    extensions,
    ExtensionContext,
    StatusBarAlignment,
    version as vscodeVersion,
    workspace,
    ConfigurationTarget,
} from 'vscode';
import * as fs from 'fs';
import { PickList } from './PickList';
import { ImgItem } from './ImgItem';
import vsHelp from './vsHelp';
import { setContext } from './global';
import { CUSTOM_CSS_FILE_PATH } from './FileDom';
import { BackgroundCoverViewProvider } from './backgroundCoverView';
import { KabegameIpcClient } from './KabegameIpcClient';
import { KabegameGalleryView } from './KabegameGalleryView';


function mapWallpaperStyleToSizeModel(style: string): string {
    const map: Record<string, string> = {
        fill: 'cover', crop: 'cover',
        fit: 'contain', contain: 'contain', stretch: 'contain',
        pad: 'center', center: 'center',
        tile: 'repeat',
    };
    return map[style] ?? 'cover';
}

export function activate(context: ExtensionContext) {
    setContext(context);

    // Status bar button - background image config
    const backImgBtn = window.createStatusBarItem(StatusBarAlignment.Right, -999);
    backImgBtn.text = '$(file-media)';
    backImgBtn.command = 'extension.backgroundCover.showMenu';
    backImgBtn.tooltip = 'Switch background image / 切换背景图';
    backImgBtn.show();
    context.subscriptions.push(backImgBtn);

    // Kabegame IPC client
    const ipcClient = new KabegameIpcClient();
    context.subscriptions.push(ipcClient);

    // Sync wallpaper when setting-change event arrives (currentWallpaperImageId or wallpaperStyle)
    context.subscriptions.push(ipcClient.onSettingChange(async (changes) => {
        const syncEnabled = workspace.getConfiguration('backgroundCover').get<boolean>('syncKabegame', true);
        if (!syncEnabled) { return; }
        const imageId = changes['currentWallpaperImageId'] as string | undefined;
        if (imageId) {
            const localPath = await ipcClient.getImageLocalPath(imageId);
            if (localPath) {
                await workspace.getConfiguration().update(
                    'backgroundCover.imagePath', localPath, ConfigurationTarget.Global
                );
                PickList.needAutoUpdate(workspace.getConfiguration('backgroundCover'));
            }
        }
        const style = changes['wallpaperStyle'] as string | undefined;
        if (style) {
            const sizeModel = mapWallpaperStyleToSizeModel(style);
            await workspace.getConfiguration().update(
                'backgroundCover.sizeModel', sizeModel, ConfigurationTarget.Global
            );
            PickList.needAutoUpdate(workspace.getConfiguration('backgroundCover'));
        }
    }));

    // Connection status bar indicator
    const connBtn = window.createStatusBarItem(StatusBarAlignment.Right, -1000);
    connBtn.text = '$(debug-disconnect)';
    connBtn.tooltip = 'Kabegame: not connected';
    connBtn.show();
    context.subscriptions.push(connBtn);
    context.subscriptions.push(ipcClient.onConnectionChange(connected => {
        connBtn.text = connected ? '$(check)' : '$(debug-disconnect)';
        connBtn.tooltip = connected ? 'Kabegame: connected' : 'Kabegame: not connected';
    }));

    // Apply background when config is changed externally (e.g. from gallery click)
    context.subscriptions.push(workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('backgroundCover.imagePath')) {
            const config = workspace.getConfiguration('backgroundCover');
            PickList.needAutoUpdate(config);
        }
    }));

    // Start IPC connection
    ipcClient.connect();

    // Apply existing background on startup
    checkVSCodeVersionChanged(context).then(isChanged => {
        if (!isChanged) {
            const config = workspace.getConfiguration('backgroundCover');
            if (config.imagePath && !fs.existsSync(CUSTOM_CSS_FILE_PATH)) {
                window.showInformationMessage(
                    'BackgroundCover: Core file needs re-initialization. Proceed?',
                    'Yes', 'No'
                ).then(result => {
                    if (result === 'Yes') {
                        PickList.needAutoUpdate(config);
                    }
                });
            } else {
                PickList.needAutoUpdate(config);
            }
        }
    });

    // Commands
    const randomCommand = commands.registerCommand('extension.backgroundCover.refresh', () => {
        const config = workspace.getConfiguration('backgroundCover');
        PickList.needAutoUpdate(config);
    });
    const startCommand = commands.registerCommand('extension.backgroundCover.start', () => {
        commands.executeCommand('setContext', 'backgroundCover.mode', 'menu');
        commands.executeCommand('workbench.view.extension.backgroundCover-explorer');
    });
    const showMenuCommand = commands.registerCommand('extension.backgroundCover.showMenu', () => {
        commands.executeCommand('setContext', 'backgroundCover.mode', 'menu');
        commands.executeCommand('workbench.view.extension.backgroundCover-explorer');
    });
    context.subscriptions.push(startCommand, randomCommand, showMenuCommand);

    // Gallery webview (replaces readerView)
    const galleryView = new KabegameGalleryView(ipcClient);
    context.subscriptions.push(galleryView);
    window.registerWebviewViewProvider('backgroundCover.readerView', galleryView, {
        webviewOptions: { retainContextWhenHidden: true },
    });

    commands.registerCommand('backgroundCover.refreshEntry', () => {
        commands.executeCommand('setContext', 'backgroundCover.mode', 'gallery');
        galleryView.refresh();
    });
    commands.registerCommand('backgroundCover.home', () => {
        commands.executeCommand('setContext', 'backgroundCover.mode', 'gallery');
        galleryView.home();
    });
    commands.registerCommand('backgroundCover.switchMode', () => {
        commands.executeCommand('setContext', 'backgroundCover.mode', 'menu');
    });

    // Tree view menu
    const backgroundCoverViewProvider = new BackgroundCoverViewProvider();
    window.registerTreeDataProvider('backgroundCover.menu', backgroundCoverViewProvider);

    context.subscriptions.push(commands.registerCommand('backgroundCover.runAction', (type: number, path?: string) => {
        const config = workspace.getConfiguration('backgroundCover');
        const quickPick = window.createQuickPick<ImgItem>();
        const pickList = new PickList(config, quickPick);
        pickList.handleAction(type, path);
    }));

    context.subscriptions.push(commands.registerCommand('backgroundCover.setConfig', async (key: string, value: any) => {
        const config = workspace.getConfiguration();
        await config.update(key, value, true);
        const newConfig = workspace.getConfiguration('backgroundCover');
        PickList.needAutoUpdate(newConfig);
    }));

    // Initialize context
    commands.executeCommand('setContext', 'backgroundCover.mode', 'menu');

    // Listen for theme changes
    window.onDidChangeActiveColorTheme((_event) => {
        PickList.autoUpdateBlendModel();
    });

    // Version update notification
    const openVersion: string | undefined = context.globalState.get('ext_version');
    const ex: Extension<any> | undefined = extensions.getExtension('manasxx.background-cover');
    const version: string = ex ? ex.packageJSON['version'] : '';

    if (openVersion !== version) {
        context.globalState.update('ext_version', version);
        vsHelp.showInfoSupport(`BackgroundCover ${version} — Now syncs with Kabegame wallpaper rotation via IPC.`);
    }
}

async function checkVSCodeVersionChanged(context: ExtensionContext): Promise<boolean> {
    const config = workspace.getConfiguration('backgroundCover');
    if (!config.imagePath) { return false; }

    const lastVSCodeVersion = context.globalState.get('vscode_version');
    if (lastVSCodeVersion && lastVSCodeVersion !== vscodeVersion) {
        const value = await window.showInformationMessage(
            'VS Code updated — reapply background image?',
            'YES', 'NO'
        );
        if (value === 'YES') {
            PickList.needAutoUpdate(config);
        }
        context.globalState.update('vscode_version', vscodeVersion);
        return true;
    }
    if (!lastVSCodeVersion) {
        context.globalState.update('vscode_version', vscodeVersion);
    }
    return false;
}

export function deactivate() {
    // IPC client disposal is handled via context.subscriptions
}
