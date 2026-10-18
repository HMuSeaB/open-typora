import {
  FileText,
  FolderOpen,
  Plus,
  RefreshCw,
  Moon,
  Sun,
  X,
  ChevronDown,
  MoreHorizontal,
  Search,
  History,
  ArrowUpDown,
  Hash,
  Folder,
  FileCode,
  FolderTree,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DocumentRecord, FileEntry, FileOperation } from "../types";
import type { Heading } from "../editor/markdown";
import { FileTree, sortFiles } from "./FileTree";
import type { FileSort } from "./FileTree";
import { host } from "../host";
import { shortcutLabel } from "../commands";

interface Props {
  documents: DocumentRecord[];
  activeId: string;
  files: FileEntry[];
  folder: string | null;
  headings: Heading[];
  tab: "files" | "outline" | "tree";
  setTab(tab: "files" | "outline" | "tree"): void;
  select(id: string): void;
  openToken(token: string): void;
  openFolder(): void;
  create(): void;
  refresh(): void;
  close(id: string): void;
  jump(line: number): void;
  theme: string;
  toggleTheme(): void;
  operation(operation: FileOperation): void;
  search(): void;
  recent(): void;
  notify(message: string): void;
}

export function Sidebar(props: Props) {
  const [sort, setSort] = useState<FileSort>(() => (localStorage.getItem("open-typora-file-sort") || "natural") as FileSort);
  const [descending, setDescending] = useState(() => localStorage.getItem("open-typora-file-desc") === "true");
  const [foldersFirst, setFoldersFirst] = useState(() => localStorage.getItem("open-typora-folders-first") !== "false");
  const [showSortMenu, setShowSortMenu] = useState(false);
  const [switcher, setSwitcher] = useState(false);
  const [activeHeadingLine, setActiveHeadingLine] = useState<number | null>(null);

  const headingRef = useRef<HTMLDivElement>(null);
  const sortMenuRef = useRef<HTMLDivElement>(null);

  const sortedFiles = useMemo(
    () => sortFiles(props.files.filter(file => file.isDirectory !== "true"), sort, descending, foldersFirst),
    [props.files, sort, descending, foldersFirst]
  );

  const activeDoc = useMemo(
    () => props.documents.find(record => record.id === props.activeId),
    [props.documents, props.activeId]
  );

  // 外部无归属草稿（未保存在当前工作区内的文档）
  const standaloneDrafts = useMemo(() => {
    if (!props.folder) return props.documents;
    return props.documents.filter(doc => !doc.path || !props.files.some(f => f.path === doc.path));
  }, [props.folder, props.documents, props.files]);

  useEffect(() => {
    localStorage.setItem("open-typora-file-sort", sort);
    localStorage.setItem("open-typora-file-desc", String(descending));
    localStorage.setItem("open-typora-folders-first", String(foldersFirst));
  }, [sort, descending, foldersFirst]);

  // 点击外部收起弹出菜单
  useEffect(() => {
    const handleDismiss = (event: MouseEvent) => {
      if (headingRef.current && !headingRef.current.contains(event.target as Node)) {
        setSwitcher(false);
      }
      if (sortMenuRef.current && !sortMenuRef.current.contains(event.target as Node)) {
        setShowSortMenu(false);
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSwitcher(false);
        setShowSortMenu(false);
      }
    };
    document.addEventListener("mousedown", handleDismiss);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleDismiss);
      document.removeEventListener("keydown", handleKey);
    };
  }, []);

  // 原生右键上下文菜单
  const handleContextMenu = async (event: React.MouseEvent, file: FileEntry | null) => {
    event.preventDefault();
    event.stopPropagation();

    if (host.showContextMenu) {
      const action = await host.showContextMenu({
        hasFile: Boolean(file),
        isDirectory: file?.isDirectory === "true",
        x: event.clientX,
        y: event.clientY,
      });

      if (!action) return;

      if (action === "copy-path" && file?.path) {
        await host.writeClipboard(file.path);
        props.notify("已复制文件路径至剪贴板");
        return;
      }

      if (action === "reveal" && file?.path) {
        await host.reveal(file.path).catch(e => props.notify(e.message));
        return;
      }

      if (["new-file", "new-folder", "duplicate", "rename", "move", "trash", "undo"].includes(action)) {
        const isDir = file?.isDirectory === "true";
        const parent = isDir
          ? file!.path
          : file?.path.slice(0, -file.name.length - 1) || props.folder || undefined;

        props.operation({
          action: action as FileOperation["action"],
          path: ["new-file", "new-folder"].includes(action) ? parent : file?.path,
          name: action === "new-file"
            ? "未命名.md"
            : action === "new-folder"
            ? "新文件夹"
            : action === "duplicate"
            ? file?.name.replace(/(\.[^.]+)$/, " 副本$1")
            : file?.name,
        });
      }
    }
  };

  const handleHeadingClick = (line: number) => {
    setActiveHeadingLine(line);
    props.jump(line);
  };

  return (
    <aside className="sidebar modern-sidebar" aria-label="文档侧栏">
      {/* 侧边栏顶部切换器 */}
      <div className="sidebar-heading" ref={headingRef}>
        <button
          className="sidebar-switcher"
          aria-label="切换侧栏内容"
          aria-expanded={switcher}
          aria-haspopup="menu"
          onClick={() => setSwitcher(!switcher)}
        >
          <span className="sidebar-switcher-text">
            {props.tab === "files" ? "文件列表" : props.tab === "tree" ? "文件树" : "文档大纲"}
          </span>
          <ChevronDown size={13} className={`switcher-arrow ${switcher ? "open" : ""}`} />
        </button>

        {switcher && (
          <div className="sidebar-menu modern-dropdown switcher-dropdown" role="menu">
            {(
              [
                ["tree", "文件树", FolderTree],
                ["files", "文件列表", FileText],
                ["outline", "文档大纲", Hash],
              ] as const
            ).map(([tab, label, Icon]) => (
              <button
                role="menuitemradio"
                aria-checked={tab === props.tab}
                key={tab}
                className={`menu-option switcher-option ${tab === props.tab ? "active" : ""}`}
                onClick={() => {
                  props.setTab(tab);
                  setSwitcher(false);
                }}
              >
                <Icon size={14} className="switcher-icon" />
                <span>{label}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="sidebar-body">
        {props.tab !== "outline" ? (
          <>
            {/* 侧边栏标题栏与工具按钮 */}
            <div className="sidebar-section-label">
              <span className="section-title" title={props.folder || "已打开文档"}>
                {props.folder ? props.folder.split(/[\/\\]/).filter(Boolean).at(-1) : "打开的文档"}
              </span>

              <div className="section-tools">
                <button
                  className="icon-button"
                  aria-label="新建文档"
                  title={`新建文档 ${shortcutLabel("Mod-N")}`}
                  onClick={props.create}
                >
                  <Plus size={15} />
                </button>

                {props.folder && (
                  <div className="sort-menu-container" ref={sortMenuRef}>
                    <button
                      className={`icon-button ${showSortMenu ? "active" : ""}`}
                      aria-label="排序与显示设置"
                      title="排序与过滤设置"
                      onClick={() => setShowSortMenu(!showSortMenu)}
                    >
                      <ArrowUpDown size={14} />
                    </button>

                    {showSortMenu && (
                      <div className="sort-dropdown modern-dropdown" role="menu">
                        <div className="dropdown-section-title">排序方式</div>
                        {(
                          [
                            ["natural", "自然名称"],
                            ["name", "字母顺序"],
                            ["modified", "修改时间"],
                            ["created", "创建时间"],
                          ] as const
                        ).map(([val, label]) => (
                          <button
                            key={val}
                            className={`menu-option ${sort === val ? "active" : ""}`}
                            onClick={() => {
                              setSort(val);
                              setShowSortMenu(false);
                            }}
                          >
                            {label}
                          </button>
                        ))}
                        <div className="dropdown-divider" />
                        <label className="checkbox-menu-item">
                          <input
                            type="checkbox"
                            checked={descending}
                            onChange={(e) => setDescending(e.target.checked)}
                          />
                          <span>降序排列</span>
                        </label>
                        <label className="checkbox-menu-item">
                          <input
                            type="checkbox"
                            checked={foldersFirst}
                            onChange={(e) => setFoldersFirst(e.target.checked)}
                          />
                          <span>文件夹优先</span>
                        </label>
                      </div>
                    )}
                  </div>
                )}

                {props.folder && (
                  <button
                    className="icon-button"
                    aria-label="更多操作"
                    title="文件夹操作"
                    onClick={(event) => handleContextMenu(event, null)}
                  >
                    <MoreHorizontal size={15} />
                  </button>
                )}

                {props.folder && (
                  <button
                    className="icon-button"
                    aria-label="刷新文件夹"
                    title="重新扫描目录"
                    onClick={props.refresh}
                  >
                    <RefreshCw size={13} />
                  </button>
                )}
              </div>
            </div>

            {/* 文件内容展示区 */}
            <nav className="sidebar-nav-container" aria-label="文件管理" onContextMenu={(e) => handleContextMenu(e, null)}>
              {/* 如果在工作区模式下，存在临时未保存草稿，单独呈现折叠组 */}
              {props.folder && standaloneDrafts.length > 0 && (
                <div className="sidebar-drafts-group">
                  <div className="sidebar-group-header">未归档草稿 ({standaloneDrafts.length})</div>
                  {standaloneDrafts.map((record) => {
                    const isCurrent = record.id === props.activeId;
                    const isDirty = record.content !== record.savedContent;
                    return (
                      <div
                        className={`modern-file-row ${isCurrent ? "active-row" : ""}`}
                        key={record.id}
                        onContextMenu={(e) => {
                          if (record.path) {
                            handleContextMenu(e, { token: "", name: record.name, path: record.path, relative: record.name });
                          }
                        }}
                      >
                        <button
                          className="modern-file-btn"
                          onClick={() => props.select(record.id)}
                          title={record.path || record.name}
                        >
                          <FileText size={15} className="file-icon" />
                          <span className="file-label">{record.name}</span>
                          {isDirty && <span className="dirty-indicator" title="未保存" />}
                        </button>
                        <button
                          className="file-close-btn"
                          aria-label={`关闭 ${record.name}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            props.close(record.id);
                          }}
                        >
                          <X size={12} />
                        </button>
                      </div>
                    );
                  })}
                  <div className="sidebar-group-divider" />
                </div>
              )}

              {/* 主体：目录树或文件列表 */}
              {props.folder ? (
                props.tab === "tree" ? (
                  <FileTree
                    files={props.files}
                    folder={props.folder}
                    activePath={activeDoc?.path}
                    open={props.openToken}
                    context={handleContextMenu}
                    move={(path, target) => props.operation({ action: "move", path, target })}
                    sort={sort}
                    descending={descending}
                    foldersFirst={foldersFirst}
                  />
                ) : (
                  sortedFiles.map((file) => {
                    const isCurrent = file.path === activeDoc?.path;
                    return (
                      <div
                        className={`modern-file-row ${isCurrent ? "active-row" : ""}`}
                        key={file.token}
                        onContextMenu={(event) => handleContextMenu(event, file)}
                      >
                        <button
                          className="modern-file-btn"
                          title={file.relative}
                          onClick={() => props.openToken(file.token)}
                        >
                          <FileText size={15} className="file-icon" />
                          <span className="file-label">{file.relative}</span>
                        </button>
                      </div>
                    );
                  })
                )
              ) : (
                /* 无工作区模式：纯展示已打开的文档 */
                props.documents.map((record) => {
                  const isCurrent = record.id === props.activeId;
                  const isDirty = record.content !== record.savedContent;
                  return (
                    <div
                      className={`modern-file-row ${isCurrent ? "active-row" : ""}`}
                      key={record.id}
                      onContextMenu={(e) => {
                        if (record.path) {
                          handleContextMenu(e, { token: "", name: record.name, path: record.path, relative: record.name });
                        }
                      }}
                    >
                      <button
                        className="modern-file-btn"
                        onClick={() => props.select(record.id)}
                        title={record.path || record.name}
                      >
                        <FileText size={15} className="file-icon" />
                        <span className="file-label">{record.name}</span>
                        {isDirty && <span className="dirty-indicator" title="未保存" />}
                      </button>
                      <button
                        className="file-close-btn"
                        aria-label={`关闭 ${record.name}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          props.close(record.id);
                        }}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  );
                })
              )}

              {!props.documents.length && !props.files.length && (
                <div className="sidebar-empty-state">
                  <FolderOpen size={32} className="empty-icon" />
                  <p>未打开任何文档或文件夹</p>
                  <button className="empty-action-btn" onClick={props.openFolder}>
                    打开文件夹…
                  </button>
                </div>
              )}
            </nav>
          </>
        ) : (
          /* 文档大纲现代重构版 */
          <nav className="modern-outline-container" aria-label="文档大纲">
            {props.headings.length ? (
              <div className="outline-tree">
                {props.headings.map((heading, index) => {
                  const isActive = activeHeadingLine === heading.line;
                  return (
                    <div
                      key={`${heading.line}-${index}`}
                      className={`outline-node level-${heading.level} ${isActive ? "active" : ""}`}
                      style={{ paddingLeft: `${Math.max(6, (heading.level - 1) * 14 + 8)}px` }}
                    >
                      <button
                        className="outline-item-btn"
                        onClick={() => handleHeadingClick(heading.line)}
                        title={heading.text}
                      >
                        <span className="outline-level-tag">H{heading.level}</span>
                        <span className="outline-text">{heading.text}</span>
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="sidebar-empty-state">
                <Hash size={32} className="empty-icon" />
                <p>正文中尚无任何标题</p>
                <small>使用 # 标题 即可生成树形大纲</small>
              </div>
            )}
          </nav>
        )}
      </div>

      {/* 底部功能栏 */}
      <div className="sidebar-footer">
        <button
          className="icon-button"
          aria-label="搜索文件夹"
          title={`搜索文件夹 ${shortcutLabel("Mod-Shift-F")}`}
          onClick={props.search}
        >
          <Search size={15} />
        </button>
        <button
          className="icon-button"
          aria-label="最近项目"
          title="最近打开的项目"
          onClick={props.recent}
        >
          <History size={15} />
        </button>
        <button
          className="icon-button"
          aria-label="打开文件夹"
          title="打开文件夹…"
          onClick={props.openFolder}
        >
          <FolderOpen size={15} />
        </button>
        <button
          className="icon-button"
          title="切换主题模式"
          aria-label="切换主题模式"
          onClick={props.toggleTheme}
        >
          {props.theme === "dark" ? <Moon size={16} /> : <Sun size={16} />}
        </button>
      </div>
    </aside>
  );
}
