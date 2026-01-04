import { Icon } from '@iconify/react';

interface IconProps {
  size?: number;
  className?: string;
  strokeWidth?: number;
}

// Pixelarticons via Iconify
// https://icon-sets.iconify.design/pixelarticons/

export function Mic({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:audio" width={size} height={size} className={className} />;
}

export function MicAlt({ size = 24, className = '' }: IconProps) {
  return (
    <svg fill="none" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={size} height={size} className={className}>
      <path d="M15 2H9v2H7v4H4v14h16V8h-3V4h-2V2zm0 2v4H9V4h6zm-6 6h9v10H6V10h3zm4 3h-2v4h2v-4z" fill="currentColor"/>
    </svg>
  );
}

export function VoiceSettings({ size = 24, className = '' }: IconProps) {
  return (
    <svg fill="none" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={size} height={size} className={className}>
      <path d="M19 2H5v2H3v14h7v-8H5V4h14v6h-5v8h3v2h-6v2h8v-4h2V4h-2V2zm-3 10h3v4h-3v-4zm-8 0v4H5v-4h3z" fill="currentColor"/>
    </svg>
  );
}

export function MicOff({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:audio-off" width={size} height={size} className={className} />;
}

export function Settings({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:sliders" width={size} height={size} className={className} />;
}

export function X({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:close" width={size} height={size} className={className} />;
}

export function Minus({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:minus" width={size} height={size} className={className} />;
}

export function Square({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:checkbox-on" width={size} height={size} className={className} />;
}

export function Maximize2({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:scale" width={size} height={size} className={className} />;
}

export function Volume2({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:volume-2" width={size} height={size} className={className} />;
}

export function VolumeX({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:volume-x" width={size} height={size} className={className} />;
}

export function Play({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:play" width={size} height={size} className={className} />;
}

export function Pause({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:pause" width={size} height={size} className={className} />;
}

export function Sun({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:sun" width={size} height={size} className={className} />;
}

export function Moon({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:moon" width={size} height={size} className={className} />;
}

export function Monitor({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:device-laptop" width={size} height={size} className={className} />;
}

export function Send({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:arrow-right" width={size} height={size} className={className} />;
}

export function Sparkles({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:zap" width={size} height={size} className={className} />;
}

export function ExternalLink({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:external-link" width={size} height={size} className={className} />;
}

export function ShieldCheck({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:shield" width={size} height={size} className={className} />;
}

export function BotMessageSquare({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:message" width={size} height={size} className={className} />;
}

export function Headphones({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:headphone" width={size} height={size} className={className} />;
}

export function ImmersiveModeIcon({ size = 24, className = '' }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" fill="currentColor" viewBox="0 0 24 24" width={size} height={size} className={className}>
      <path d="M22 2h-2v2h2v12h-2v2h2v-2h2V4h-2V2ZM2 4H0v12h2v2h2v-2H2V4Zm0 0V2h2v2H2Zm4 2H4v8h2V6Zm0 0V4h2v2H6Zm4 0h4v2h-4V6Zm0 6H8V8h2v4Zm4 0h-4v2H8v4H6v4h2v-4h2v-4h4v4h2v4h2v-4h-2v-4h-2v-2Zm0 0h2V8h-2v4Zm6-6h-2V4h-2v2h2v8h2V6Z"/>
    </svg>
  );
}

export function GameModeIcon({ size = 24, className = '' }: IconProps) {
  return (
    <svg fill="none" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={size} height={size} className={className}>
      <path d="M2 5h20v14H2V5zm18 12V7H4v10h16zM8 9h2v2h2v2h-2v2H8v-2H6v-2h2V9zm6 0h2v2h-2V9zm4 4h-2v2h2v-2z" fill="currentColor"/>
    </svg>
  );
}

export function ProfileIcon({ size = 24, className = '' }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" fill="currentColor" viewBox="0 0 24 24" width={size} height={size} className={className}>
      <path d="M22 2h-2v2h2v12h-2v2h2v-2h2V4h-2V2ZM2 4H0v12h2v2h2v-2H2V4Zm0 0V2h2v2H2Zm4 2H4v8h2V6Zm0 0V4h2v2H6Zm4 0h4v2h-4V6Zm0 6H8V8h2v4Zm4 0h-4v2H8v4H6v4h2v-4h2v-4h4v4h2v4h2v-4h-2v-4h-2v-2Zm0 0h2V8h-2v4Zm6-6h-2V4h-2v2h2v8h2V6Z"/>
    </svg>
  );
}

export function VoiceChanger({ size = 24, className = '' }: IconProps) {
  return (
    <svg fill="none" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={size} height={size} className={className}>
      <path d="M4 2H3v20h18V2H4zm15 2v16H5V4h14zm-6 2h-2v2h2V6zm-5 4h8v6h-2v-4h-4v4H8v-6zm8 6H8v2h8v-2z" fill="currentColor"/>
    </svg>
  );
}

export function ClipboardCopy({ size = 24, className = '' }: IconProps) {
  return (
    <svg fill="none" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={size} height={size} className={className}>
      <path d="M10 2h6v2h4v18H4V4h4V2h2zm6 4v2H8V6H6v14h12V6h-2zm-2 0V4h-4v2h4z" fill="currentColor"/>
    </svg>
  );
}

export function ClipboardCheck({ size = 24, className = '' }: IconProps) {
  return (
    <svg fill="none" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={size} height={size} className={className}>
      <path d="M18 6h2v2h-2V6zm-2 4V8h2v2h-2zm-2 2v-2h2v2h-2zm-2 2h2v-2h-2v2zm-2 2h2v-2h-2v2zm-2 0v2h2v-2H8zm-2-2h2v2H6v-2zm0 0H4v-2h2v2z" fill="currentColor"/>
    </svg>
  );
}

export function ChevronDown({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:chevron-down" width={size} height={size} className={className} />;
}

export function ChevronUp({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:chevron-up" width={size} height={size} className={className} />;
}

export function ChevronLeft({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:chevron-left" width={size} height={size} className={className} />;
}

export function ChevronRight({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:chevron-right" width={size} height={size} className={className} />;
}

export function Check({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:check" width={size} height={size} className={className} />;
}

export function AlertCircle({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:alert" width={size} height={size} className={className} />;
}

export function Info({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:info-box" width={size} height={size} className={className} />;
}

export function Copy({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:copy" width={size} height={size} className={className} />;
}

export function Trash({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:trash" width={size} height={size} className={className} />;
}

export function Edit({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:edit" width={size} height={size} className={className} />;
}

export function Plus({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:plus" width={size} height={size} className={className} />;
}

export function User({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:user" width={size} height={size} className={className} />;
}

export function MessageSquare({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:message-text" width={size} height={size} className={className} />;
}

export function Clock({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:clock" width={size} height={size} className={className} />;
}

export function Calendar({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:calendar" width={size} height={size} className={className} />;
}

export function RotateCcw({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:undo" width={size} height={size} className={className} />;
}

export function RefreshCw({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:reload" width={size} height={size} className={className} />;
}

export function Download({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:download" width={size} height={size} className={className} />;
}

export function Upload({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:upload" width={size} height={size} className={className} />;
}

export function Eye({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:eye" width={size} height={size} className={className} />;
}

export function EyeOff({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:eye-closed" width={size} height={size} className={className} />;
}

export function Lock({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:lock" width={size} height={size} className={className} />;
}

export function Unlock({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:lock-open" width={size} height={size} className={className} />;
}

export function Key({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:label" width={size} height={size} className={className} />;
}

export function Save({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:save" width={size} height={size} className={className} />;
}

export function FileText({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:file" width={size} height={size} className={className} />;
}

export function Folder({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:folder" width={size} height={size} className={className} />;
}

export function Search({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:search" width={size} height={size} className={className} />;
}

export function Filter({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:sort" width={size} height={size} className={className} />;
}

export function MoreHorizontal({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:more-horizontal" width={size} height={size} className={className} />;
}

export function MoreVertical({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:more-vertical" width={size} height={size} className={className} />;
}

export function Menu({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:menu" width={size} height={size} className={className} />;
}

export function Home({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:home" width={size} height={size} className={className} />;
}

export function ArrowLeft({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:arrow-left" width={size} height={size} className={className} />;
}

export function ArrowRight({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:arrow-right" width={size} height={size} className={className} />;
}

export function ArrowUp({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:arrow-up" width={size} height={size} className={className} />;
}

export function ArrowDown({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:arrow-down" width={size} height={size} className={className} />;
}

export function Zap({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:zap" width={size} height={size} className={className} />;
}

export function Heart({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:heart" width={size} height={size} className={className} />;
}

export function Star({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:bookmark" width={size} height={size} className={className} />;
}

export function Bell({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:notification" width={size} height={size} className={className} />;
}

export function Mail({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:mail" width={size} height={size} className={className} />;
}

export function Link({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:link" width={size} height={size} className={className} />;
}

export function Image({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:image" width={size} height={size} className={className} />;
}

export function Video({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:video" width={size} height={size} className={className} />;
}

export function Music({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:music" width={size} height={size} className={className} />;
}

export function Wifi({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:radio-on" width={size} height={size} className={className} />;
}

export function WifiOff({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:radio-off" width={size} height={size} className={className} />;
}

export function Power({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:power" width={size} height={size} className={className} />;
}

export function Terminal({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:script" width={size} height={size} className={className} />;
}

export function Code({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:code" width={size} height={size} className={className} />;
}

export function Database({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:server" width={size} height={size} className={className} />;
}

export function Cloud({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:cloud" width={size} height={size} className={className} />;
}

export function CloudOff({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:cloud-off" width={size} height={size} className={className} />;
}

export function Loader({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:loader" width={size} height={size} className={className} />;
}

export function Loader2({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:loader" width={size} height={size} className={`animate-spin ${className}`} />;
}

export function Trash2({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:trash" width={size} height={size} className={className} />;
}

export function Circle({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:radio-on" width={size} height={size} className={className} />;
}

export function Key2({ size = 24, className = '' }: IconProps) {
  return <Icon icon="pixelarticons:label" width={size} height={size} className={className} />;
}

export function ApiKeyIcon({ size = 24, className = '' }: IconProps) {
  return (
    <svg fill="none" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={size} height={size} className={className}>
      <path d="M6 2h12v2H6V2zM4 6V4h2v2H4zm0 12V6H2v12h2zm2 2v-2H4v2h2zm12 0v2H6v-2h12zm2-2v2h-2v-2h2zm0-12h2v12h-2V6zm0 0V4h-2v2h2zm-9-1h2v2h3v2h-6v2h6v6h-3v2h-2v-2H8v-2h6v-2H8V7h3V5z" fill="currentColor"/>
    </svg>
  );
}

export function ElevenLabsIcon({ size = 24, className = '' }: IconProps) {
  // Pixel art waveform/audio icon for ElevenLabs
  return (
    <svg 
      fill="none" 
      xmlns="http://www.w3.org/2000/svg" 
      viewBox="0 0 24 24" 
      width={size} 
      height={size}
      className={className}
    >
      <path d="M6 7h2v10H6V7zM11 4h2v16h-2V4zM16 9h2v6h-2V9z" fill="currentColor"/>
    </svg>
  );
}
