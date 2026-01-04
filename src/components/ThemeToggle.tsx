import { useEffect } from 'react';
import { Sun, Moon, Monitor } from './icons';
import { useAppStore, Theme } from '../store';

export function ThemeToggle() {
  const { theme, setTheme } = useAppStore();

  // Apply theme to document
  useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove('light', 'dark');

    if (theme === 'system') {
      const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
      root.classList.add(systemTheme);
    } else {
      root.classList.add(theme);
    }
  }, [theme]);

  // Listen for system theme changes when in system mode
  useEffect(() => {
    if (theme !== 'system') return;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (e: MediaQueryListEvent) => {
      const root = window.document.documentElement;
      root.classList.remove('light', 'dark');
      root.classList.add(e.matches ? 'dark' : 'light');
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [theme]);

  // Cycle through: system -> light -> dark -> system
  const toggleTheme = () => {
    const nextTheme: Theme = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
    setTheme(nextTheme);
  };

  const getIcon = () => {
    if (theme === 'system') {
      return <Monitor className="w-4 h-4 text-ash/70 transition-colors group-hover:[color:#00D4FF]" strokeWidth={1.5} />;
    } else if (theme === 'dark') {
      return <Moon className="w-4 h-4 text-ash/70 transition-colors group-hover:[color:#E040FB]" strokeWidth={1.5} />;
    } else {
      return <Sun className="w-4 h-4 text-slate-600 transition-colors group-hover:[color:#EAB308]" strokeWidth={1.5} />;
    }
  };

  const getTitle = () => {
    if (theme === 'system') return 'System Theme (⌘T) → Light';
    if (theme === 'light') return 'Light Mode (⌘T) → Dark';
    return 'Dark Mode (⌘T) → System';
  };

  return (
    <button
      onClick={toggleTheme}
      className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg hover:bg-smoke/20 transition-all cursor-pointer group"
      aria-label={getTitle()}
      title={getTitle()}
    >
      {getIcon()}
      <kbd className="p-1 bg-smoke/30 rounded text-[10px] font-mono text-ash/60 border border-smoke/40 leading-none aspect-square flex items-center justify-center">⌘T</kbd>
    </button>
  );
}
