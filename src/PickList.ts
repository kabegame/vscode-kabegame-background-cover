import * as fs from 'fs';
import * as path from 'path';
import {
	QuickPick,
	Disposable,
	QuickPickItemKind,
	workspace,
	WorkspaceConfiguration,
	window,
	commands,
	env,
	Uri,
	extensions,
	InputBoxOptions,
	ConfigurationTarget,
} from 'vscode';

import { FileDom } from './FileDom';
import { ImgItem } from './ImgItem';
import vsHelp from './vsHelp';
import { getContext } from './global';
import { BlendHelper } from './BlendHelper';



// Action Types Enum to replace magic numbers
export enum ActionType {
    SelectPictures = 1,
    ManualSelection = 3,
    UpdateBackground = 4,
    BackgroundOpacity = 5,
    CloseBackground = 7,
    ReloadWindow = 8,
    CloseMenu = 9,
    MoreMenu = 12,
    OpenExternalUrl = 13,
    OpenFilePath = 14,
    SizeModeMenu = 15,
    SetSizeMode = 16,
    BackgroundBlur = 18,
}

// Input Types Enum
enum InputType {
    Opacity = 1,
    Blur = 2,
}

export class PickList {
    public static itemList: PickList | undefined;

    private readonly quickPick: QuickPick<ImgItem> | any;
    private _disposables: Disposable[] = [];
    private config: WorkspaceConfiguration;
    private imgPath: string;
    private opacity: number;
    private imageFileType: number;
    private sizeModel: string;
    private blur: number;

    // --- Static Entry Points ---

    public static createItemLIst() {
        const config = workspace.getConfiguration('backgroundCover');
        const list = window.createQuickPick<ImgItem>();
        list.placeholder = 'Please choose configuration! / 请选择相关配置！';
        list.totalSteps = 2;
        list.title = "背景图设置";
        
        PickList.itemList = new PickList(config, list);
        PickList.itemList.showMainMenu();
    }

    public static needAutoUpdate(config: WorkspaceConfiguration) {
        if (config.imagePath == '') { return; }

        const nowBlenaStr = BlendHelper.autoBlendModel();
        PickList.itemList = new PickList(config);
        PickList.itemList.updateDom(false, nowBlenaStr as string).then((requiresReload) => {
            if (requiresReload) {
                commands.executeCommand('workbench.action.reloadWindow');
            }
        }).catch(error => {
            console.error("Error updating the DOM:", error);
        });
    }

    public static autoUpdateBlendModel() {
        const config = workspace.getConfiguration('backgroundCover');
        if (config.imagePath == '') { return; }

        const context = getContext();
        const blendStr = context.globalState.get('backgroundCoverBlendModel');
        const nowBlenaStr = BlendHelper.autoBlendModel();
        if (blendStr == nowBlenaStr) { return false; }

        window.showInformationMessage('主题模式发生变更，是否更新背景混合模式？', 'YES', 'NO').then(
            (value) => {
                if (value === 'YES') {
                    PickList.itemList = new PickList(config);
                    PickList.itemList.updateDom(false, nowBlenaStr as string).then((requiresReload) => {
                        if (requiresReload) {
                            commands.executeCommand('workbench.action.reloadWindow');
                        }
                    });
                }
            }
        );
    }


    public static gotoFilePath(path?: string) {
        if (path == undefined) {
            return window.showWarningMessage('无效菜单');
        }
        const extPath = extensions.getExtension("manasxx.background-cover")?.extensionPath;
        const tmpPath = "file:///" + extPath + path;
        const tmpurl = Uri.parse(tmpPath);
        commands.executeCommand('vscode.openFolder', tmpurl);
    }

    // --- Instance Methods ---

    public constructor(config: WorkspaceConfiguration, pickList?: QuickPick<ImgItem>) {
        this.config = config;
        this.imgPath = config.imagePath;
        this.opacity = config.opacity;
        this.sizeModel = config.sizeModel || 'cover';
        this.imageFileType = 0;
        this.blur = config.blur;

        if (pickList) {
            this.quickPick = pickList;
            this.quickPick.onDidAccept((e: any) => {
                if (this.quickPick.selectedItems.length > 0) {
                    this.handleAction(
                        this.quickPick.selectedItems[0].imageType,
                        this.quickPick.selectedItems[0].path
                    );
                }
            });
            this.quickPick.onDidHide(() => {
                this.dispose();
            }, null, this._disposables);
            this.quickPick.show();
        }
    }

    public getMainMenuItems(): ImgItem[] {
        const items: ImgItem[] = [];

        items.push(
            { label: 'Image Source / 图片来源', kind: QuickPickItemKind.Separator, imageType: 0 },
            { label: '$(file-media) Select Pictures', detail: '选择一张背景图', imageType: ActionType.SelectPictures },
        );

        items.push(
            { label: 'Appearance / 外观设置', kind: QuickPickItemKind.Separator, imageType: 0 },
            { label: '$(settings) Background Opacity', detail: '更新图片不透明度', imageType: ActionType.BackgroundOpacity },
            { label: '$(settings) Background Blur', detail: '模糊度', imageType: ActionType.BackgroundBlur },
            { label: '$(layout) Size Mode', detail: '尺寸适应模式 / size adaptive mode', imageType: ActionType.SizeModeMenu }
        );

        items.push(
            { label: 'Actions / 操作', kind: QuickPickItemKind.Separator, imageType: 0 },
            { label: '$(refresh) Refresh Background', detail: '刷新背景图 / Refresh background', imageType: ActionType.UpdateBackground },
            { label: '$(eye-closed) Closing Background', detail: '关闭背景图', imageType: ActionType.CloseBackground }
        );

        items.push(
            { label: 'About / 关于', kind: QuickPickItemKind.Separator, imageType: 0 },
            { label: '$(github) Github', detail: 'Github信息', imageType: ActionType.MoreMenu },
        );

        return items;
    }

    private showMainMenu() {
        this.quickPick.items = this.getMainMenuItems();
    }

    public handleAction(type: ActionType, path?: string) {
        switch (type) {
            case ActionType.SelectPictures: this.showImageSelectionList(); break;
            case ActionType.ManualSelection: this.openFieldDialog(); break;
            case ActionType.UpdateBackground: this.updateBackgound(path); break;
            case ActionType.BackgroundOpacity: this.showInputBox(InputType.Opacity); break;
            case ActionType.CloseBackground: this.updateDom(true); break;
            case ActionType.ReloadWindow: commands.executeCommand('workbench.action.reloadWindow'); break;
            case ActionType.CloseMenu: this.quickPick.hide(); break;
            case ActionType.MoreMenu: this.showMoreMenu(); break;
            case ActionType.OpenExternalUrl: this.gotoPath(path); break;
            case ActionType.OpenFilePath: PickList.gotoFilePath(path); break;
            case ActionType.SizeModeMenu: this.showSizeModeMenu(); break;
            case ActionType.SetSizeMode: this.setSizeModel(path); break;
            case ActionType.BackgroundBlur: this.showInputBox(InputType.Blur); break;
            default: break;
        }
    }

    private gotoPath(path?: string) {
        if (path == undefined) { return window.showWarningMessage('无效菜单'); }
        env.openExternal(Uri.parse(path));
    }

    public getMoreMenuItems(): ImgItem[] {
        return [
            { label: '$(github) Repository', detail: '仓库地址', imageType: ActionType.OpenExternalUrl, path: "https://github.com/AShujiao/vscode-background-cover" },
            { label: '$(issues) Issues', detail: '有疑问就来提问', imageType: ActionType.OpenExternalUrl, path: "https://github.com/AShujiao/vscode-background-cover/issues" },
            { label: '$(star) Star', detail: '给作者点个Star吧', imageType: ActionType.OpenExternalUrl, path: "https://github.com/AShujiao/vscode-background-cover" }
        ];
    }

    private showMoreMenu() {
        this.quickPick.items = this.getMoreMenuItems();
        this.quickPick.show();
    }

    public getSizeModeMenuItems(): ImgItem[] {
        const modes = [
            { label: 'cover (default)', value: 'cover', desc: '填充(默认)' },
            { label: 'repeat', value: 'repeat', desc: '平铺' },
            { label: 'contain', value: 'contain', desc: '拉伸' },
            { label: 'center', value: 'center', desc: '居中' },
        ];

        return modes.map(m => ({
            label: `$(layout) ${m.label}`,
            detail: `${m.desc} ${this.sizeModel == m.value ? '$(check)' : ''}`,
            imageType: ActionType.SetSizeMode,
            path: m.value
        }));
    }

    private showSizeModeMenu() {
        this.quickPick.items = this.getSizeModeMenuItems();
        this.quickPick.show();
    }

    private dispose() {
        PickList.itemList = undefined;
        this.quickPick.hide();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) { x.dispose(); }
        }
    }

    private showImageSelectionList(folderPath?: string) {
        let items: ImgItem[] = [{
            label: '$(diff-added) Manual selection',
            detail: '选择一张背景图',
            imageType: ActionType.ManualSelection
        }];

        const randomPath: any = folderPath;
        if (this.checkFolder(randomPath)) {
            const files = this.getFolderImgList(randomPath);
            if (files.length > 0) {
                const randomFile = files[Math.floor(Math.random() * files.length)];
                items.push({
                    label: '$(light-bulb) Random pictures',
                    detail: '随机自动选择       ctrl+shift+F7',
                    imageType: ActionType.UpdateBackground,
                    path: path.join(randomPath, randomFile)
                });
                items.push({ label: '', description: '', imageType: 0, kind: QuickPickItemKind.Separator });
                items = items.concat(files.map(
                    (e) => new ImgItem('$(tag) ' + e, e, ActionType.UpdateBackground, path.join(randomPath, e))
                ));
            }
        }
        this.quickPick.items = items;
        this.quickPick.show();
    }

    private getFolderImgList(pathUrl: string): string[] {
        if (!pathUrl || pathUrl === '') { return []; }
        return fs.readdirSync(path.resolve(pathUrl)).filter((s) => {
            // 增加视频文件 '.mp4', '.webm', '.ogg', '.mov'
            return s.endsWith('.png') || s.endsWith('.PNG') || s.endsWith('.jpg') || s.endsWith('.JPG')
                || s.endsWith('.jpeg') || s.endsWith('.gif') || s.endsWith('.webp') || s.endsWith('.bmp')
                || s.endsWith('.jfif') || s.endsWith('.mp4') || s.endsWith('.webm') || s.endsWith('.ogg') || s.endsWith('.mov');
        });
    }

    private checkFolder(folderPath: string) {
        if (!folderPath) { return false; }
        const fsStatus = fs.existsSync(path.resolve(folderPath));
        if (!fsStatus) { return false; }
        const stat = fs.statSync(folderPath);
        return stat.isDirectory();
    }

    private async showInputBox(type: InputType) {
        let placeString = '';
        let promptString = '';

        switch (type) {
            case InputType.Opacity:
                placeString = 'Opacity ranges：0.00 - 0.8,current:(' + this.opacity + ')';
                promptString = '设置图片不透明度：0 - 0.8,当前值：' + this.opacity;
                break;
            case InputType.Blur:
                placeString = 'Set image blur: 0-100,current:(' + this.blur + ')';
                promptString = '设置图片模糊度：0 - 100,当前值：' + this.blur;
                break;
        }

        const option: InputBoxOptions = {
            ignoreFocusOut: true,
            password: false,
            placeHolder: placeString,
            prompt: promptString
        };

        const value = await window.showInputBox(option);
        if (!value) {
            window.showWarningMessage('Please enter configuration parameters / 请输入配置参数！');
            return false;
        }

        if (type === InputType.Opacity) {
            const isOpacity = parseFloat(value);
            if (isOpacity < 0 || isOpacity > 0.8 || isNaN(isOpacity)) {
                window.showWarningMessage('Opacity ranges in：0 - 0.8！');
                return false;
            }
            await this.setConfigValue('opacity', isOpacity, true);
        } else if (type === InputType.Blur) {
            const blur = parseFloat(value);
            if (blur < 0 || blur > 100 || isNaN(blur)) {
                window.showWarningMessage('Blur ranges in：0 - 100！');
                return false;
            }
            await this.setConfigValue('blur', blur, true);
        }
    }

    private async setSizeModel(value?: string) {
        if (!value) { return vsHelp.showInfo('No parameter value was obtained / 未获取到参数值'); }
        await this.setConfigValue('sizeModel', value, true);
    }

    public setImageFileType(value: number) {
        this.imageFileType = value;
    }

    public async updateBackgound(path?: string, persist: boolean = true) {
        if (!path) { path = this.config.get<string>('imagePath'); }
        if (!path) { return vsHelp.showInfo('Unfetched Picture Path / 未获取到图片路径'); }
        await this.setConfigValue('imagePath', path, true, persist);
    }

    private async openFieldDialog() {
        const uris = await window.showOpenDialog({
            canSelectFolders: false,
            canSelectFiles: true,
            canSelectMany: false,
            openLabel: 'Select file',
            filters: { 'Images': ['png', 'jpg', 'gif', 'jpeg', 'jfif', 'webp', 'bmp', 'mp4', 'webm', 'ogg', 'mov'] }
        });
        if (!uris || !uris[0]) { return false; }
        return this.updateBackgound(uris[0].fsPath);
    }

    private async setConfigValue(name: string, value: any, updateDom: Boolean = true, persist: boolean = true) {
        if (persist) {
            await this.config.update(name, value, ConfigurationTarget.Global);
            this.config = workspace.getConfiguration('backgroundCover');
        }
        switch (name) {
            case 'opacity': this.opacity = value; break;
            case 'imagePath': this.imgPath = value; break;
            case 'sizeModel': this.sizeModel = value; break;
            case 'blur': this.blur = value; break;
            default: break;
        }
        if (updateDom) { await this.updateDom(); }
        return true;
    }

    private async updateDom(uninstall: boolean = false, colorThemeKind: string = ""): Promise<boolean> {
        if (colorThemeKind == "") {
            colorThemeKind = BlendHelper.autoBlendModel();
        }

        const context = getContext();
        context.globalState.update('backgroundCoverBlendModel', colorThemeKind);

        const dom = new FileDom(this.config, this.imgPath, this.opacity, this.sizeModel, this.blur, colorThemeKind);
        let result = false;

        try {
            if (uninstall) {
                this.config.update("imagePath", "", ConfigurationTarget.Global);
                result = await dom.clearBackground();
            } else {
                result = await dom.install();
            }

            if (result) {
                if (!dom.requiresReload) {
                    if (this.quickPick) {
                        this.quickPick.hide();
                    }
                    const triggerMsg = window.setStatusBarMessage('background-cover-reload-trigger');
                    
                    setTimeout(() => {
                        triggerMsg.dispose();
                        window.setStatusBarMessage('Background updated successfully! / 背景更新成功！', 5000);
                    }, 1000);
                    
                    return false;
                }

                if (this.quickPick) {
                    this.quickPick.placeholder = 'Reloading takes effect? / 重新加载生效？';
                    this.quickPick.items = [
                        { label: '$(check) YES', detail: '立即重新加载窗口生效', imageType: ActionType.ReloadWindow },
                        { label: '$(x) NO', detail: '稍后手动重启', imageType: ActionType.CloseMenu }
                    ];
                    this.quickPick.ignoreFocusOut = true;
                    this.quickPick.show();
                } else {
                    if (this.imageFileType === 2) {
                        const value = await window.showInformationMessage(
                            `"${this.imgPath}" | Reloading takes effect? / 重新加载生效？`,
                            'YES', 'NO'
                        );
                        if (value === 'YES') {
                            await commands.executeCommand('workbench.action.reloadWindow');
                        }
                    }

                }
            }
        } catch (error: any) {
            await window.showErrorMessage(`更新失败: ${error.message}`);
        }
        return result && (dom.requiresReload || uninstall);
    }
}