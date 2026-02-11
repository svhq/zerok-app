interface ProgressBarProps {
  progress: number; // 0-100
  variant?: 'default' | 'gradient';
  className?: string;
}

export default function ProgressBar({
  progress,
  variant = 'default',
  className = ''
}: ProgressBarProps) {
  const clampedProgress = Math.min(100, Math.max(0, progress));

  return (
    <div className={`progress-bar ${className}`}>
      <div
        className={`progress-bar-fill ${variant === 'gradient' ? '' : 'bg-zk-teal'}`}
        style={{ width: `${clampedProgress}%` }}
      />
    </div>
  );
}
