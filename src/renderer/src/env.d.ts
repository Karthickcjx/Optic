import type { DesktopAPI } from '../../shared/protocol';
declare global { interface Window { desktop: DesktopAPI } }
declare global { const __APP_VERSION__: string; }
