import * as vscode from 'vscode';
import { ActionType } from './PickList';
import { onDidChangeGlobalState } from './global';

// Localization
const messages = {
    en: {
        imageSource: 'Image Source',
        appearance: 'Appearance',
        actions: 'Actions',
        currentImage: 'Current Image',
        selectImage: 'Select Image...',
        opacity: 'Opacity',
        blur: 'Blur',
        sizeMode: 'Size Mode',
        blendMode: 'Blend Mode',
        clearBackground: 'Clear Background',
        refresh: 'Refresh',
        kabegameGallery: 'Kabegame Gallery',
        syncKabegame: 'Sync with Kabegame',
        setSizeMode: 'Set Size Mode',
        setBlendMode: 'Set Blend Mode',
        toggle: 'Toggle',
        notSet: 'Not Set',
        none: 'None',
    },
    zh: {
        imageSource: '图片来源',
        appearance: '外观设置',
        actions: '操作',
        currentImage: '当前图片',
        selectImage: '选择图片/视频文件...',
        opacity: '透明度',
        blur: '模糊度',
        sizeMode: '尺寸模式',
        blendMode: '混合模式',
        clearBackground: '清除背景',
        refresh: '刷新',
        kabegameGallery: 'Kabegame 画廊',
        syncKabegame: '同步 Kabegame',
        setSizeMode: '设置尺寸模式',
        setBlendMode: '设置混合模式',
        toggle: '切换',
        notSet: '未设置',
        none: '无',
    }
};

function t(key: keyof typeof messages.en): string {
    const lang = vscode.env.language;
    if (lang.startsWith('zh')) {
        return messages.zh[key];
    }
    return messages.en[key];
}

// Define a data structure for tree items
export class ConfigItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly type: 'group' | 'setting' | 'action' | 'value',
        public readonly key?: string,
        public readonly value?: any,
        public readonly commandType?: ActionType,
        public readonly description?: string,
        public readonly icon?: string
    ) {
        super(label, collapsibleState);
        this.contextValue = type;
        if (description) {
            this.description = description;
        }
        if (icon) {
            this.iconPath = new vscode.ThemeIcon(icon);
        }
    }
}

export class BackgroundCoverViewProvider implements vscode.TreeDataProvider<ConfigItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<ConfigItem | undefined | void> = new vscode.EventEmitter<ConfigItem | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<ConfigItem | undefined | void> = this._onDidChangeTreeData.event;

    constructor() {
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('backgroundCover')) {
                this.refresh();
            }
        });

        onDidChangeGlobalState.event(() => {
            this.refresh();
        });
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: ConfigItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: ConfigItem): Thenable<ConfigItem[]> {
        const config = vscode.workspace.getConfiguration('backgroundCover');

        if (!element) {
            return Promise.resolve(this.getRootItems(config));
        }

        if (element.type === 'group') {
            return Promise.resolve(this.getGroupChildren(element, config));
        }

        if (element.type === 'setting' && element.key === 'backgroundCover.sizeModel') {
            return Promise.resolve(this.getSizeModeOptions(config));
        }

        if (element.type === 'setting' && element.key === 'backgroundCover.blendModel') {
            return Promise.resolve(this.getBlendModeOptions(config));
        }

        return Promise.resolve([]);
    }

    private getRootItems(config: vscode.WorkspaceConfiguration): ConfigItem[] {
        return [
            new ConfigItem(t('imageSource'), vscode.TreeItemCollapsibleState.Expanded, 'group', undefined, undefined, undefined, undefined, 'file-media'),
            new ConfigItem(t('appearance'), vscode.TreeItemCollapsibleState.Expanded, 'group', undefined, undefined, undefined, undefined, 'paintcan'),
            new ConfigItem(t('actions'), vscode.TreeItemCollapsibleState.Expanded, 'group', undefined, undefined, undefined, undefined, 'tools'),
        ];
    }

    private getGroupChildren(element: ConfigItem, config: vscode.WorkspaceConfiguration): ConfigItem[] {
        const items: ConfigItem[] = [];

        if (element.label === t('imageSource')) {
            const currentPath = config.get<string>('imagePath') || t('none');
            const displayPath = currentPath.length > 30 ? '...' + currentPath.substr(-30) : currentPath;

            items.push(new ConfigItem(t('currentImage'), vscode.TreeItemCollapsibleState.None, 'value', undefined, undefined, undefined, displayPath, 'file'));
            items.push(this.createActionItem(t('selectImage'), ActionType.SelectPictures, 'folder-opened'));
            const galleryItem = new ConfigItem(
                t('kabegameGallery'),
                vscode.TreeItemCollapsibleState.None,
                'action',
                undefined, undefined, undefined,
                undefined,
                'book'
            );
            galleryItem.command = {
                command: 'backgroundCover.home',
                title: t('kabegameGallery'),
            };
            items.push(galleryItem);
        }

        if (element.label === t('appearance')) {
            items.push(this.createSettingItem(t('opacity'), 'backgroundCover.opacity', config.get('opacity'), ActionType.BackgroundOpacity, 'eye'));
            items.push(this.createSettingItem(t('blur'), 'backgroundCover.blur', config.get('blur'), ActionType.BackgroundBlur, 'star-half'));
            items.push(new ConfigItem(t('sizeMode'), vscode.TreeItemCollapsibleState.Collapsed, 'setting', 'backgroundCover.sizeModel', config.get('sizeModel'), undefined, config.get('sizeModel'), 'layout'));
            items.push(new ConfigItem(t('blendMode'), vscode.TreeItemCollapsibleState.Collapsed, 'setting', 'backgroundCover.blendModel', config.get('blendModel'), undefined, config.get('blendModel'), 'symbol-color'));
        }

        if (element.label === t('actions')) {
            const syncEnabled = config.get<boolean>('syncKabegame', true);
            const syncItem = new ConfigItem(
                t('syncKabegame'),
                vscode.TreeItemCollapsibleState.None,
                'action',
                undefined, undefined, undefined,
                syncEnabled ? 'ON' : 'OFF',
                syncEnabled ? 'check' : 'circle-outline'
            );
            syncItem.command = {
                command: 'backgroundCover.setConfig',
                title: t('syncKabegame'),
                arguments: ['backgroundCover.syncKabegame', !syncEnabled]
            };
            items.push(syncItem);
            items.push(this.createActionItem(t('clearBackground'), ActionType.CloseBackground, 'trash'));
            items.push(this.createActionItem(t('refresh'), ActionType.UpdateBackground, 'refresh'));
        }

        return items;
    }

    private getSizeModeOptions(config: vscode.WorkspaceConfiguration): ConfigItem[] {
        const modes = ['cover', 'repeat', 'contain', 'center'];
        const current = config.get<string>('sizeModel');

        return modes.map(mode => {
            const item = new ConfigItem(mode, vscode.TreeItemCollapsibleState.None, 'value', 'backgroundCover.sizeModel', mode, undefined, undefined, current === mode ? 'check' : 'circle-outline');
            item.command = {
                command: 'backgroundCover.setConfig',
                title: t('setSizeMode'),
                arguments: ['backgroundCover.sizeModel', mode]
            };
            return item;
        });
    }

    private getBlendModeOptions(config: vscode.WorkspaceConfiguration): ConfigItem[] {
        const modes = ["auto", "multiply", "lighten"];
        const current = config.get<string>('blendModel');

        return modes.map(mode => {
            const item = new ConfigItem(mode, vscode.TreeItemCollapsibleState.None, 'value', 'backgroundCover.blendModel', mode, undefined, undefined, current === mode ? 'check' : 'circle-outline');
            item.command = {
                command: 'backgroundCover.setConfig',
                title: t('setBlendMode'),
                arguments: ['backgroundCover.blendModel', mode]
            };
            return item;
        });
    }

    private createActionItem(label: string, actionType: ActionType, icon: string, description?: string, path?: string): ConfigItem {
        const item = new ConfigItem(label, vscode.TreeItemCollapsibleState.None, 'action', undefined, undefined, actionType, description, icon);
        item.command = {
            command: 'backgroundCover.runAction',
            title: label,
            arguments: [actionType, path]
        };
        return item;
    }

    private createSettingItem(label: string, key: string, value: any, actionType: ActionType, icon: string): ConfigItem {
        const item = new ConfigItem(label, vscode.TreeItemCollapsibleState.None, 'setting', key, value, actionType, String(value), icon);
        item.command = {
            command: 'backgroundCover.runAction',
            title: label,
            arguments: [actionType]
        };
        return item;
    }
}
