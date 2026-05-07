import {
  Copy,
  FileInput,
  FileOutput,
  FilePlus,
  FolderOpen,
  Menu,
  Minus,
  Music,
  Save,
  Settings,
  Square,
  Video,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../common/Button';
import { getTauriWindow } from '../../utils/tauri-window';

interface TitleBarProps {
  projectName?: string;
  mode?: 'video' | 'audio';
  onModeChange?: (mode: 'video' | 'audio') => void;
  onSettingsClick?: () => void;
  isDesktop?: boolean;
  isDirty?: boolean;
  onSaveProject?: () => Promise<void>;
  menuActions?: MenuAction[];
}

export type MenuActionIcon = 'new' | 'open' | 'save' | 'import' | 'export';

export interface MenuAction {
  icon: MenuActionIcon;
  label: string;
  action?: () => Promise<void>;
  errorLabel: string;
  shortcut?: string;
  dividerBefore?: boolean;
}

const menuIcons = {
  new: FilePlus,
  open: FolderOpen,
  save: Save,
  import: FileInput,
  export: FileOutput,
} as const;

export function TitleBar({
  projectName,
  isDirty = false,
  mode = 'video',
  onModeChange,
  onSettingsClick,
  isDesktop = false,
  onSaveProject,
  menuActions = [],
}: TitleBarProps) {
  const { t } = useTranslation();
  const displayProjectName = projectName ?? t('titleBar.untitledProject');
  const [isMaximized, setIsMaximized] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const clickCountRef = useRef(0);
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isDesktop) return;

    let unlistenResize: (() => void) | undefined;
    let cancelled = false;

    const syncMaximizedState = async () => {
      const maximized = await (await getTauriWindow()).isMaximized();
      if (!cancelled) {
        setIsMaximized((current) => (current === maximized ? current : maximized));
      }
    };

    void (async () => {
      const windowHandle = await getTauriWindow();
      unlistenResize = await windowHandle.listen('tauri://resize', () => {
        void syncMaximizedState();
      });
      await syncMaximizedState();
    })();

    return () => {
      cancelled = true;
      unlistenResize?.();
    };
  }, [isDesktop]);

  const handleMouseDown = useCallback(async (event: React.MouseEvent) => {
    if (!isDesktop || event.button !== 0) return;
    if (menuOpen) return;
    if ((event.target as HTMLElement).closest('button')) return;

    clickCountRef.current += 1;

    if (clickCountRef.current === 1) {
      clickTimerRef.current = setTimeout(() => {
        clickCountRef.current = 0;
      }, 300);

      await (await getTauriWindow()).startDragging();
      return;
    }

    if (clickCountRef.current === 2) {
      if (clickTimerRef.current) {
        clearTimeout(clickTimerRef.current);
        clickTimerRef.current = null;
      }

      clickCountRef.current = 0;
      const windowHandle = await getTauriWindow();
      if (await windowHandle.isMaximized()) {
        await windowHandle.unmaximize();
        setIsMaximized(false);
      } else {
        await windowHandle.maximize();
        setIsMaximized(true);
      }
    }
  }, [isDesktop, menuOpen]);

  const handleMinimize = async () => {
    await (await getTauriWindow()).minimize();
  };

  const handleMaximize = async () => {
    const windowHandle = await getTauriWindow();
    if (await windowHandle.isMaximized()) {
      await windowHandle.unmaximize();
      setIsMaximized(false);
    } else {
      await windowHandle.maximize();
      setIsMaximized(true);
    }
  };

  const handleClose = async () => {
    await (await getTauriWindow()).close();
  };

  useEffect(() => {
    return () => {
      if (clickTimerRef.current) {
        clearTimeout(clickTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) return;

    const handleDocumentMouseDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as HTMLElement)) {
        setMenuOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handleDocumentMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleDocumentMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [menuOpen]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 's') {
        event.preventDefault();
        void onSaveProject?.();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onSaveProject]);

  const runMenuAction = useCallback(async (action?: () => Promise<void>, errorLabel?: string) => {
    setMenuOpen(false);

    if (!action) return;

    try {
      await action();
    } catch (error) {
      const label = errorLabel ?? t('titleBar.operationFailed');
      console.error(`${label}:`, error);
      alert(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [t]);

  const shortcutLabel = useMemo(() => (navigator.userAgent.includes('Mac') ? '⌘S' : 'Ctrl+S'), []);
  const resolvedMenuActions = useMemo<MenuAction[]>(() => menuActions.map((item) => {
    if (item.shortcut != null) {
      return item;
    }
    if (item.action === onSaveProject) {
      return { ...item, shortcut: shortcutLabel };
    }
    return item;
  }), [menuActions, onSaveProject, shortcutLabel]);

  return (
    <div
      className={`relative flex h-8 items-center border-b border-zinc-800 bg-zinc-900 ${isDesktop ? 'select-none' : ''}`}
      onMouseDown={handleMouseDown}
      data-testid="title-bar"
    >
      <div className="flex items-center px-3">
        <span className="text-sm font-bold text-zinc-300">OpenDirector</span>
        <button
          onMouseDown={(event) => event.stopPropagation()}
          onClick={() => setMenuOpen((value) => !value)}
          className="ml-1.5 rounded p-1 text-zinc-200 transition-colors hover:bg-zinc-800 hover:text-white"
          aria-label={t('titleBar.menu')}
        >
          <Menu size={16} />
        </button>

        {menuOpen && (
          <div
            ref={menuRef}
            className="absolute left-3 top-8 z-50 min-w-[220px] rounded-md border border-zinc-700 bg-zinc-800 py-1 shadow-lg"
            onMouseDown={(event) => event.stopPropagation()}
          >
            {resolvedMenuActions.map((item) => {
              const Icon = menuIcons[item.icon];

              return (
                <div key={item.label}>
                  {item.dividerBefore && <div className="my-1 border-t border-zinc-700" />}
                  <button
                    className="flex w-full items-center gap-2 px-3 py-2 text-sm font-normal text-zinc-200 transition-colors hover:bg-zinc-700"
                    onClick={() => {
                      void runMenuAction(item.action, item.errorLabel);
                    }}
                  >
                    <Icon size={14} />
                    <span>{item.label}</span>
                    {item.shortcut && (
                      <span className="ml-auto pl-8 text-xs text-zinc-500">{item.shortcut}</span>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="absolute left-1/2 -translate-x-1/2">
        <span className="text-sm text-zinc-400">
          {displayProjectName}
          {isDirty && ' *'}
        </span>
      </div>

      <div className="ml-auto flex items-center">
        <div className="mr-2 flex rounded-lg bg-zinc-800 p-0.5">
          <Button
            variant={mode === 'video' ? 'primary' : 'ghost'}
            size="sm"
            onClick={() => onModeChange?.('video')}
            data-testid="mode-video"
            className="h-6 px-2"
          >
            <Video size={14} className="mr-1" />
            {t('titleBar.videoMode')}
          </Button>
          <Button
            variant={mode === 'audio' ? 'primary' : 'ghost'}
            size="sm"
            onClick={() => onModeChange?.('audio')}
            data-testid="mode-audio"
            className="h-6 px-2"
          >
            <Music size={14} className="mr-1" />
            {t('titleBar.audioMode')}
          </Button>
        </div>

        <Button
          variant="ghost"
          size="sm"
          onClick={onSettingsClick}
          className="mr-2 h-6 w-6 p-0"
          aria-label={t('titleBar.settings')}
        >
          <Settings size={16} />
        </Button>

        {isDesktop && (
          <>
            <button
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => {
                void handleMinimize();
              }}
              className="flex h-8 w-11 items-center justify-center text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-white"
              aria-label={t('titleBar.minimize')}
            >
              <Minus size={14} />
            </button>
            <button
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => {
                void handleMaximize();
              }}
              className="flex h-8 w-11 items-center justify-center text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-white"
              aria-label={isMaximized ? t('titleBar.restore') : t('titleBar.maximize')}
            >
              {isMaximized ? <Copy size={12} /> : <Square size={12} />}
            </button>
            <button
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => {
                void handleClose();
              }}
              className="flex h-8 w-11 items-center justify-center text-zinc-400 transition-colors hover:bg-red-600 hover:text-white"
              aria-label={t('titleBar.close')}
            >
              <X size={14} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
