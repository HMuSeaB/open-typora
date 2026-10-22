import {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  protocol,
  net,
  shell,
  session,
  clipboard,
} from "electron";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pandocPath, convertExport, convertImport, themes, installTheme } from "./interchange.mjs";
import { Workspace } from "./workspace.mjs";
import { randomUUID } from "node:crypto";
import { atomicWrite, DocumentStore } from "./store.mjs";
import { readFile, realpath, stat } from "node:fs/promises";
import { launchFiles } from "./launch-files.mjs";
import { plugins, installPlugin } from "./plugins.mjs";
import { pluginResource } from "./resources.mjs";
import { readBackground, saveBackground, clearBackground } from "./background.mjs";
import { suggestMarkdownName } from "./suggest-name.mjs";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const development = process.env.OPEN_TYPORA_DEV_URL;
if (process.env.OPEN_TYPORA_DATA_DIR)
  app.setPath("userData", process.env.OPEN_TYPORA_DATA_DIR);
app.setName("Open Typora");
protocol.registerSchemesAsPrivileged([
  { scheme: "opentypora", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  {
    scheme: "open-typora-asset",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);
let window,
  store, workspace,
  dirty = false,
  closing = false;
const pending = [];
let rendererReady = false;
const pluginToken = randomUUID();
const authorizedPlugin = item => item && ({ ...item, url: item.url + "?token=" + pluginToken });

async function openTarget(targetPath) {
  try {
    const targetStat = await stat(targetPath);
    if (targetStat.isDirectory()) {
      const scanned = await store.scan(targetPath);
      await workspace.remember(targetPath, true);
      send({ action: "opened-folder", folder: scanned.folder, files: scanned.files });
    } else {
      const document = await store.open(targetPath);
      await workspace.remember(targetPath, false);
      send({ action: "opened", document });
    }
  } catch (err) {
    showError(err);
  }
}

function openFiles(files) {
  for (const file of files) {
    if (window && rendererReady) void openTarget(file);
    else pending.push(file);
  }
}
if (process.platform === "win32") {
  app.setAppUserModelId("org.opentypora.desktop");
  if (!app.requestSingleInstanceLock()) app.quit();
  else {
    pending.push(...launchFiles(process.argv, app.isPackaged));
    app.on("second-instance", (_, argv, cwd) => {
      openFiles(launchFiles(argv, app.isPackaged, cwd));
      if (window?.isMinimized()) window.restore();
      window?.show();
      window?.focus();
    });
  }
}
app.on("open-file", (event, file) => {
  event.preventDefault();
  openFiles([file]);
});
const send = (command) =>
  window?.webContents.send(
    "app:command",
    typeof command === "string" ? { action: command } : command,
  );
const showError = (error) => dialog.showErrorBox("Open Typora", error.message);
const handshakes = new Map();
ipcMain.on("workspace:prepared", (event, id, value) => { if (event.sender !== window?.webContents) return; handshakes.get(id)?.(value); });
function prepareOperation(phase, change) { return new Promise((resolve, reject) => { const id = randomUUID(), timeout = setTimeout(() => { handshakes.delete(id); reject(new Error("文件操作等待超时。")); }, 30000); handshakes.set(id, value => { clearTimeout(timeout); handshakes.delete(id); resolve(value); }); window.webContents.send("workspace:operation", id, phase, change); }); }
let operationRunning = false;
const handlers = {
  toggleFullScreen: () => {
    if (!window) return false;
    const next = !window.isFullScreen();
    window.setFullScreen(next);
    return next;
  },
  background: () => readBackground(store.dataDir),
  clearBackground: () => clearBackground(store.dataDir),
  chooseBackground: async () => {
    const result = await dialog.showOpenDialog(window,{title:"选择背景图片",filters:[{name:"背景图片",extensions:["png","jpg","jpeg","webp"]}],properties:["openFile"]});
    if (result.canceled || !result.filePaths[0]) return null;
    const file = result.filePaths[0];
    if ((await stat(file)).size > 8 * 1024 * 1024) throw new Error("背景图片须小于 8 MB。");
    return saveBackground(store.dataDir,await readFile(file),path.basename(file),async (_bytes,dataUrl) => {
      // Chromium supports WebP consistently; nativeImage's supported codecs differ by host.
      const size = await window.webContents.executeJavaScript(`(async () => {
        const image = new Image(); image.src = ${JSON.stringify(dataUrl)};
        let timer;
        try { await Promise.race([image.decode(),new Promise((_,reject) => {timer = setTimeout(() => reject(new Error('decode timeout')),10000);})]); return {width:image.naturalWidth,height:image.naturalHeight}; }
        catch { return {width:0,height:0}; }
        finally {clearTimeout(timer);image.src='';}
      })()`);
      if (!size.width || !size.height || size.width * size.height > 40_000_000) throw new Error("图片无效或分辨率超过 4000 万像素，请选择较小的图片。");
    });
  },
  plugins: async () => (await plugins(store.dataDir)).map(authorizedPlugin),
  removePlugin: async (_, id) => { if (!/^local-[a-f0-9]{64}$/.test(id)) throw new Error("插件标识无效。"); const root = await realpath(path.join(store.dataDir, "plugins")); if (path.dirname(root) !== await realpath(store.dataDir)) throw new Error("插件目录无效。"); for (const suffix of [".json", ".mjs"]) { const file = path.join(root, id + suffix); try { if (path.dirname(await realpath(file)) !== root) throw new Error("插件资源路径无效。"); await shell.trashItem(file); } catch (error) { if (error.code !== "ENOENT") throw error; } } return true; },
  installPlugin: async () => { const result = await dialog.showOpenDialog(window, { filters: [{ name: "JavaScript", extensions: ["js", "cjs"] }], properties: ["openFile"] }); return result.canceled ? null : authorizedPlugin(await installPlugin(result.filePaths[0], store.dataDir)); },
  themes: () => themes(store.dataDir),
  installTheme: async () => { const result = await dialog.showOpenDialog(window, { filters: [{ name: "CSS", extensions: ["css"] }], properties: ["openFile"] }); return result.canceled ? null : installTheme(result.filePaths[0], store.dataDir); },
  conversionSettings: async (_, choose) => { if (choose) { const result = await dialog.showOpenDialog(window, { title: "选择 Pandoc 可执行文件", properties: ["openFile"] }); if (!result.canceled) process.env.OPEN_TYPORA_PANDOC = result.filePaths[0]; } return { word: process.platform === "darwin", pandoc: await pandocPath() }; },
  importDocument: async () => { const result = await dialog.showOpenDialog(window, { title: "导入文档", properties: ["openFile"], filters: [{ name: "文档", extensions: ["docx", "doc", "rtf", "odt", "epub", "tex", "rst", "html", "txt"] }] }); return result.canceled ? null : convertImport(result.filePaths[0]); },
  exportConverted: async (_, id, format, source, html) => { const record = store.require(id), ext = { latex: "tex", revealjs: "html", mediawiki: "wiki" }[format] || format; const result = await dialog.showSaveDialog(window, { defaultPath: record.name.replace(/\.[^.]+$/, "." + ext) }); return result.canceled ? null : convertExport(store.dataDir, format, source, html, result.filePath); },
  imageAction: async (_, id, sources, action, options) => { if (action !== "upload") throw new Error("图片文件管理请使用原生安装版。"); const mapping = {}; for (const source of sources) { const file = await store.asset(id, source); const response = await fetch(options?.imageUploader || "http://127.0.0.1:36677/upload", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ list: [file] }), signal: AbortSignal.timeout(30000) }); const result = await response.json(); if (!response.ok || !result.success || !/^https?:\/\//.test(result.result?.[0] || "")) throw new Error("PicGo 未返回有效图片地址。"); mapping[source] = result.result[0]; } return mapping; },
  openPath: async (_, targetPath) => {
    const targetStat = await stat(targetPath);
    if (targetStat.isDirectory()) {
      const scanned = await store.scan(targetPath);
      await workspace.remember(targetPath, true);
      return { type: "folder", folder: scanned.folder, files: scanned.files };
    } else {
      const document = await store.open(targetPath);
      await workspace.remember(targetPath, false);
      return { type: "file", document };
    }
  },
  ready: async () => {
    rendererReady = true;
    for (const file of pending.splice(0)) {
      void openTarget(file);
    }
    return true;
  },
  cancelClose: () => { closing = false; },
  recent: () => workspace.recent(),
  recentAction: async (_, action, file) => { if (action !== "open") return workspace.recentAction(action, file); const item = (await workspace.recent()).find(item => item.path === file); if (!item) throw new Error("最近项目已移除。"); await workspace.remember(file, item.folder); return item.folder ? store.scan(file) : store.open(file); },
  searchFiles: async (_, query, options) => workspace.search((await store.scan()).files, query, { ...options, encodings: Object.fromEntries([...store.records.values()].filter(record => record.path).map(record => [record.path, record.encoding])) }),
  reveal: async (_, file) => shell.showItemInFolder(await workspace.authorize(file, store)),
  showContextMenu: async (_, options) => {
    return new Promise((resolve) => {
      let settled = false;
      const done = (action) => {
        if (!settled) {
          settled = true;
          resolve(action);
        }
      };
      const { hasFile, isDirectory, hasPath, type, x, y } = options || {};
      const isWin = process.platform === "win32";
      if (type === "tab") {
        const tabTemplate = [
          { label: "关闭标签页", click: () => done("close") },
          { label: "关闭其他标签页", click: () => done("close-others") },
          { label: "关闭已保存标签页", click: () => done("close-saved") },
        ];
        if (hasPath) {
          tabTemplate.push(
            { type: "separator" },
            { label: "复制路径", click: () => done("copy-path") },
            {
              label: isWin ? "在文件资源管理器中显示" : "在访达中显示",
              click: () => done("reveal"),
            }
          );
        }
        const contextMenu = Menu.buildFromTemplate(tabTemplate);
        contextMenu.popup({
          window,
          x: typeof x === "number" ? Math.round(x) : undefined,
          y: typeof y === "number" ? Math.round(y) : undefined,
          callback: () => {
            setTimeout(() => done(null), 150);
          },
        });
        return;
      }
      if (type === "editor") {
        const { hasSelection, isTable, readOnly } = options || {};
        const mod = isWin ? "Ctrl+" : "Cmd+";
        const editorTemplate = [
          { label: "剪切", accelerator: `${mod}X`, role: "cut", enabled: !readOnly && Boolean(hasSelection) },
          { label: "复制", accelerator: `${mod}C`, role: "copy", enabled: Boolean(hasSelection) },
          { label: "粘贴", accelerator: `${mod}V`, role: "paste", enabled: !readOnly },
          { label: "粘贴为纯文本", accelerator: `${mod}Shift+V`, enabled: !readOnly, click: () => done("paste-plain") },
          { label: "复制为 Markdown", accelerator: `${mod}Shift+C`, enabled: Boolean(hasSelection), click: () => done("copy-markdown") },
          { type: "separator" },
          {
            label: "插入",
            submenu: [
              { label: "表格…", accelerator: `${mod}T`, enabled: !readOnly, click: () => done("table") },
              { label: "代码块", accelerator: `${mod}Shift+K`, enabled: !readOnly, click: () => done("code") },
              { label: "公式块", accelerator: `${mod}Shift+M`, enabled: !readOnly, click: () => done("math-block") },
              { label: "超链接…", accelerator: `${mod}K`, enabled: !readOnly, click: () => done("link") },
              { label: "图片…", accelerator: `${mod}Shift+I`, enabled: !readOnly, click: () => done("image") },
              { type: "separator" },
              { label: "水平分割线", enabled: !readOnly, click: () => done("hr") },
              { label: "引用", accelerator: `${mod}Alt+Q`, enabled: !readOnly, click: () => done("quote") },
              { label: "内容目录 (TOC)", enabled: !readOnly, click: () => done("toc") },
            ],
          },
          {
            label: "格式",
            submenu: [
              { label: "加粗", accelerator: `${mod}B`, enabled: !readOnly, click: () => done("bold") },
              { label: "斜体", accelerator: `${mod}I`, enabled: !readOnly, click: () => done("italic") },
              { label: "下划线", accelerator: `${mod}U`, enabled: !readOnly, click: () => done("underline") },
              { label: "删除线", accelerator: `${mod}Shift+\``, enabled: !readOnly, click: () => done("strike") },
              { label: "行内代码", accelerator: `${mod}Shift+\``, enabled: !readOnly, click: () => done("inline-code") },
              { label: "高亮", enabled: !readOnly, click: () => done("highlight") },
              { type: "separator" },
              { label: "清除格式", enabled: !readOnly, click: () => done("clear-format") },
            ],
          },
          {
            label: "段落",
            submenu: [
              { label: "一级标题", accelerator: `${mod}1`, enabled: !readOnly, click: () => done("heading-1") },
              { label: "二级标题", accelerator: `${mod}2`, enabled: !readOnly, click: () => done("heading-2") },
              { label: "三级标题", accelerator: `${mod}3`, enabled: !readOnly, click: () => done("heading-3") },
              { label: "四级标题", accelerator: `${mod}4`, enabled: !readOnly, click: () => done("heading-4") },
              { label: "五级标题", accelerator: `${mod}5`, enabled: !readOnly, click: () => done("heading-5") },
              { label: "六级标题", accelerator: `${mod}6`, enabled: !readOnly, click: () => done("heading-6") },
              { label: "普通段落", accelerator: `${mod}0`, enabled: !readOnly, click: () => done("heading-0") },
              { type: "separator" },
              { label: "提升标题级别", accelerator: `${mod}=`, enabled: !readOnly, click: () => done("heading-up") },
              { label: "降低标题级别", accelerator: `${mod}-`, enabled: !readOnly, click: () => done("heading-down") },
              { type: "separator" },
              { label: "有序列表", accelerator: `${mod}Alt+O`, enabled: !readOnly, click: () => done("ordered-list") },
              { label: "无序列表", accelerator: `${mod}Alt+U`, enabled: !readOnly, click: () => done("unordered-list") },
              { label: "任务列表", enabled: !readOnly, click: () => done("task-list") },
              { type: "separator" },
              { label: "在上方插入段落", enabled: !readOnly, click: () => done("paragraph-above") },
              { label: "在下方插入段落", enabled: !readOnly, click: () => done("paragraph-below") },
            ],
          },
        ];

        if (isTable) {
          editorTemplate.push({
            label: "表格",
            submenu: [
              { label: "上方插入行", enabled: !readOnly, click: () => done("table-rowBefore") },
              { label: "下方插入行", enabled: !readOnly, click: () => done("table-row") },
              { label: "左侧插入列", enabled: !readOnly, click: () => done("table-columnBefore") },
              { label: "右侧插入列", enabled: !readOnly, click: () => done("table-column") },
              { type: "separator" },
              { label: "删除行", accelerator: `${mod}Shift+Backspace`, enabled: !readOnly, click: () => done("table-removeRow") },
              { label: "删除列", enabled: !readOnly, click: () => done("table-removeColumn") },
              { type: "separator" },
              { label: "左对齐", enabled: !readOnly, click: () => done("table-left") },
              { label: "居中对齐", enabled: !readOnly, click: () => done("table-center") },
              { label: "右对齐", enabled: !readOnly, click: () => done("table-right") },
              { type: "separator" },
              { label: "删除表格", enabled: !readOnly, click: () => done("table-deleteTable") },
            ],
          });
        }

        editorTemplate.push(
          { type: "separator" },
          { label: "查找与替换", accelerator: `${mod}F`, click: () => done("find") },
          { label: "全选", accelerator: `${mod}A`, role: "selectAll" }
        );

        const contextMenu = Menu.buildFromTemplate(editorTemplate);
        contextMenu.popup({
          window,
          x: typeof x === "number" ? Math.round(x) : undefined,
          y: typeof y === "number" ? Math.round(y) : undefined,
          callback: () => {
            setTimeout(() => done(null), 150);
          },
        });
        return;
      }
      const template = [
        { label: "新建文件…", click: () => done("new-file") },
        { label: "新建文件夹…", click: () => done("new-folder") },
      ];
      if (hasFile) {
        template.push({ type: "separator" });
        if (!isDirectory) {
          template.push({ label: "创建副本…", click: () => done("duplicate") });
        }
        template.push(
          { label: "重命名…", click: () => done("rename") },
          { label: "移动到…", click: () => done("move") },
          { label: "移到废纸篓", click: () => done("trash") },
          { type: "separator" },
          { label: "复制路径", click: () => done("copy-path") },
          {
            label: isWin ? "在文件资源管理器中显示" : "在访达中显示",
            click: () => done("reveal"),
          }
        );
      }
      template.push(
        { type: "separator" },
        { label: "撤销上次文件操作", click: () => done("undo") }
      );
      const contextMenu = Menu.buildFromTemplate(template);
      contextMenu.popup({
        window,
        x: typeof x === "number" ? Math.round(x) : undefined,
        y: typeof y === "number" ? Math.round(y) : undefined,
        callback: () => {
          setTimeout(() => done(null), 150);
        },
      });
    });
  },
  fileOperation: async (_, operation) => {
    if (operationRunning) throw new Error("另一个文件操作正在进行。"); operationRunning = true;
    try {
      if (operation.action === "trash") { const answer = await dialog.showMessageBox(window, { message: "移到废纸篓？", detail: operation.path, buttons: ["取消", "移到废纸篓"], cancelId: 0 }); if (answer.response !== 1) return null; }
      if (!await prepareOperation("prepare", { removedPath: operation.action === "trash" ? operation.path : undefined })) throw new Error("文件操作已取消。");
      const change = await workspace.execute(operation, store, file => shell.trashItem(file)); workspace.apply(change, store);
      await prepareOperation("commit", change); return change;
    } finally { try { await prepareOperation("release", {}); } finally { operationRunning = false; } }
  },
  restore: async () => {
    const restored = await store.restore();
    if (restored) return restored;
    const samples = JSON.parse(
      await readFile(path.join(root, "shared/samples.json"), "utf-8"),
    );
    const folder = path.join(app.getPath("userData"), "示例笔记");
    const documents = [];
    for (const sample of samples) {
      const file = path.join(folder, sample.name);
      try {
        await readFile(file);
      } catch (error) {
        if (error.code === "ENOENT") await atomicWrite(file, process.platform === "win32" ? sample.content.replace(/⌘\s*/g, "Ctrl+") : sample.content);
        else throw error;
      }
      documents.push(await store.open(file));
    }
    await store.scan(folder);
    return { documents, activeId: documents[0].id, folder };
  },
  draft: (_, record) => store.registerDraft(record),
  open: async () => {
    const result = await dialog.showOpenDialog(window, {
      title: "打开 Markdown 文件",
      properties: ["openFile"],
      filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdown"] }],
    });
    return result.canceled ? null : store.open(result.filePaths[0]);
  },
  folder: async () => {
    const result = await dialog.showOpenDialog(window, {
      title: "打开笔记文件夹",
      properties: ["openDirectory"],
    });
    return result.canceled ? null : store.scan(result.filePaths[0]);
  },
  scan: () => store.scan(),
  token: async (_, token) => { const record = await store.openToken(token); await workspace.remember(record.path); return record; },
  reopen: (_, id) => store.reload(id),
  writeClipboard: (_, text) => clipboard.writeText(String(text)),
  readClipboard: () => clipboard.readText(),
  chooseImage: async (_, id, options) => {
    store.require(id);
    const result = await dialog.showOpenDialog(window, { title: "插入图片", properties: ["openFile"], filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }] });
    if (result.canceled) return null;
    const file = result.filePaths[0];
    return { path: await store.importImage(id, new Uint8Array(await readFile(file)), path.basename(file), options), alt: path.basename(file) };
  },
  html: async (_, name, html) => {
    const result = await dialog.showSaveDialog(window, { title: "导出 HTML", defaultPath: String(name).replace(/\.(?:md|markdown|mdown)$/i, "") + ".html", filters: [{ name: "HTML", extensions: ["html"] }] });
    if (result.canceled) return null;
    await atomicWrite(result.filePath, String(html)); return result.filePath;
  },
  confirmClose: async (_, name) => {
    const result = await dialog.showMessageBox(window, { type: "question", message: `保存对“${String(name).slice(0,150)}”所做的修改？`, buttons: ["保存", "取消", "不保存"], defaultId: 0, cancelId: 1 });
    return ["save", "cancel", "discard"][result.response];
  },
  save: async (_, id, text, saveAs, force, options) => {
    const record = store.require(id);
    let destination;
    if (!record.path || saveAs) {
      const suggestedName = suggestMarkdownName(text, record.name);
      let defaultPath;
      if (record.path) {
        defaultPath = saveAs ? path.join(path.dirname(record.path), suggestedName) : record.path;
      } else if (store.folder) {
        defaultPath = path.join(store.folder, suggestedName);
      } else {
        defaultPath = suggestedName;
      }
      const result = await dialog.showSaveDialog(window, {
        title: "保存 Markdown 文件",
        defaultPath,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (result.canceled) return null;
      destination = result.filePath;
    }
    if (force) {
      const result = await dialog.showMessageBox(window, {
        type: "warning",
        message: "覆盖磁盘上的修改？",
        detail: "当前草稿将替换磁盘文件。也可以取消并另存为副本。",
        buttons: ["取消", "覆盖"],
        defaultId: 0,
        cancelId: 0,
      });
      if (result.response !== 1) return null;
    }
    return store.save(id, text, destination, force, options);
  },
  persist: (_, value) => store.persist(value),
  check: (_, id) => store.check(id),
  reload: (_, id, encoding) => store.reload(id, encoding),
  acceptDisk: async (_, id, content, hash) => {
    const disk = await store.check(id);
    if (!disk || disk.content !== content || disk.diskHash !== hash)
      throw new Error("磁盘内容已再次变化。");
    return store.acceptDisk(id, content, hash, disk.bom, disk.encoding);
  },
  image: (_, id, bytes, name, options) => store.importImage(id, bytes, name, options),
  pdf: async () => {
    const result = await dialog.showSaveDialog(window, {
      title: "导出 PDF",
      defaultPath: "文档.pdf",
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (result.canceled) return null;
    const data = await window.webContents.printToPDF({
      printBackground: true,
      pageSize: "A4",
      margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 },
    });
    await atomicWrite(result.filePath, data);
    return result.filePath;
  },
  link: async (_, url) => {
    const parsed = new URL(url);
    if (!["https:", "http:", "mailto:"].includes(parsed.protocol))
      throw new Error("链接类型不受支持。");
    const result = await dialog.showMessageBox(window, {
      message: "在浏览器中打开链接？",
      detail: parsed.href,
      buttons: ["取消", "打开"],
      defaultId: 0,
      cancelId: 0,
    });
    if (result.response === 1) await shell.openExternal(parsed.href);
  },
  documentLink: async (_, id, address) => {
    const record = store.require(id), relative = decodeURIComponent(String(address).split("#")[0]);
    if (!record.path || path.isAbsolute(relative) || relative.includes(":") || relative.includes("\\")) throw new Error("请先保存文档，并使用相对 Markdown 文件路径。");
    const base = await realpath(path.dirname(record.path)), target = await realpath(path.resolve(base, relative));
    if (!target.startsWith(base + path.sep)) throw new Error("链接位于当前文档目录之外，请用“打开文件”选择目标。");
    send({ action: "opened", document: await store.open(target) });
  },
  discard: async (_, name) => {
    const result = await dialog.showMessageBox(window, {
      type: "question",
      message: `关闭「${String(name).slice(0, 150)}」？`,
      detail: "尚未保存的修改将从当前会话移除。",
      buttons: ["取消", "关闭"],
      defaultId: 0,
      cancelId: 0,
    });
    return result.response === 1;
  },
  dirty: (_, value) => {
    dirty = Boolean(value);
    if (process.platform === "darwin") window?.setDocumentEdited(dirty);
  },
};
app
  .whenReady()
  .then(async () => {
    if (process.platform === "win32" && !app.hasSingleInstanceLock()) return;
    store = new DocumentStore(app.getPath("userData"));
    workspace = new Workspace(app.getPath("userData"));
    protocol.handle("opentypora", async request => {
      try {
        if (new URL(request.url).searchParams.get("token") !== pluginToken) throw new Error("插件会话无效。");
        const { bytes, mime } = await pluginResource(request.url, store.dataDir);
        const headers = { "Content-Type": mime, "X-Content-Type-Options": "nosniff" };
        const origin = request.headers.get("origin");
        if (origin === "null" || origin === "file://" || (development && origin === new URL(development).origin)) headers["Access-Control-Allow-Origin"] = origin;
        return new Response(bytes, { headers });
      } catch { return new Response("Resource unavailable", { status: 404 }); }
    });
    protocol.handle("open-typora-asset", async (request) => {
      try {
        const url = new URL(request.url);
        const [id, ...rest] = url.pathname.slice(1).split("/");
        const file = await store.asset(
          decodeURIComponent(id),
          decodeURIComponent(rest.join("/")),
        );
        return net.fetch(pathToFileURL(file).href);
      } catch {
        return new Response("Image unavailable", { status: 404 });
      }
    });
    for (const [name, handler] of Object.entries(handlers))
      ipcMain.handle(`document:${name}`, async (event, ...args) => {
        if (
          event.sender !== window?.webContents ||
          event.senderFrame !== window.webContents.mainFrame
        )
          return { ok: false, error: "来源无效。" };
        try {
          return { ok: true, value: await handler(event, ...args) };
        } catch (error) {
          return { ok: false, error: error.message, code: error.code };
        }
      });
    function createWindow() {
      window = new BrowserWindow({
        show: process.env.OPEN_TYPORA_TEST_HIDDEN !== "1",
        width: 1380,
        height: 960,
        minWidth: 660,
        minHeight: 500,
        title: "Open Typora",
        ...(process.platform === "darwin" ? {
          titleBarStyle: "hiddenInset", trafficLightPosition: { x: 12, y: 9 },
        } : {}),
        backgroundColor: "#FFFFFF",
        webPreferences: {
          backgroundThrottling: process.env.OPEN_TYPORA_TEST_HIDDEN !== "1",
          preload: path.join(root, "electron/preload.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      session.defaultSession.setPermissionRequestHandler((_, __, callback) =>
        callback(false),
      );
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event) => event.preventDefault());
      window.webContents.setVisualZoomLevelLimits(1, 1);
      if (development) window.loadURL(development);
      else window.loadFile(path.join(root, "dist/index.html"));
      window.on("close", (event) => {
        if (!closing && dirty) {
          event.preventDefault();
          send("quit");
        }
      });
      window.on("closed", () => {
        window = null;
        rendererReady = false;
      });
    }
    ipcMain.handle("app:close", (event) => {
      if (event.sender === window?.webContents) {
        closing = true;
        window.close();
        app.quit();
      }
    });
    const command = (action) => () => send(action);
    const groups = JSON.parse(await readFile(path.join(root, "shared/commands.json"), "utf8"));
    const roles = { "cut:": "cut", "copy:": "copy", "paste:": "paste", "selectAll:": "selectAll" };
    const accelerator = key => key?.replaceAll("Mod-", "CommandOrControl+").replaceAll("Ctrl-", "Control+").replaceAll("Alt-", "Alt+").replaceAll("Shift-", "Shift+");
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: "Open Typora", submenu: [{ label: "关于 Open Typora", click: command("about") }, { label: "偏好设置…", accelerator: "CommandOrControl+,", click: command("preferences") }, ...(process.platform === "darwin" ? [{ type: "separator" }, { role: "hide", label: "隐藏 Open Typora" }, { role: "hideOthers", label: "隐藏其他应用" }] : []), { type: "separator" }, { label: "退出 Open Typora", accelerator: "CommandOrControl+Q", click: command("quit") }] },
      ...groups.map(group => ({ label: group.title, submenu: group.items.filter(item => item.action !== "preferences").map(item => ({ label: item.label, accelerator: accelerator(item.key), ...(item.selector ? { role: roles[item.selector] } : { click: command(item.action) }) })) })),
      { role: "windowMenu", label: "窗口" }
    ]));
    createWindow();
    app.on("activate", () => {
      if (!window) {
        closing = false;
        createWindow();
      }
    });
    app.on("window-all-closed", () => {
      if (process.platform !== "darwin") app.quit();
    });
  })
  .catch((error) => {
    console.error(error);
    app.quit();
  });
