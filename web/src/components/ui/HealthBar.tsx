interface HealthBarProps {
  /** Health percentage 0-100 */
  health: number;
  className?: string;
}

export default function HealthBar({ health, className = '' }: HealthBarProps) {
  const clampedHealth = Math.min(100, Math.max(0, health));

  // Determine color based on health
  const getHealthClass = () => {
    if (clampedHealth >= 60) return 'healthy';
    if (clampedHealth >= 30) return 'warning';
    return 'danger';
  };

  return (
    <div className={`health-bar ${className}`}>
      <div
        className={`health-bar-fill ${getHealthClass()}`}
        style={{ width: `${clampedHealth}%` }}
      />
    </div>
  );
}
