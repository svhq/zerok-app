'use client';

interface CounterProps {
  value: number;
  min?: number;
  max?: number;
  onChange: (value: number) => void;
}

export default function Counter({ value, min = 1, max = 10, onChange }: CounterProps) {
  const decrement = () => {
    if (value > min) onChange(value - 1);
  };

  const increment = () => {
    if (value < max) onChange(value + 1);
  };

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={decrement}
        disabled={value <= min}
        className="w-10 h-10 rounded-lg bg-zk-surface border border-zk-border text-zk-text flex items-center justify-center hover:bg-zk-surface-light hover:border-zk-teal disabled:opacity-30 disabled:cursor-not-allowed transition-all"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
        </svg>
      </button>

      <span className="w-12 text-center text-xl font-semibold text-zk-text">{value}</span>

      <button
        onClick={increment}
        disabled={value >= max}
        className="w-10 h-10 rounded-lg bg-zk-surface border border-zk-border text-zk-text flex items-center justify-center hover:bg-zk-surface-light hover:border-zk-teal disabled:opacity-30 disabled:cursor-not-allowed transition-all"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
        </svg>
      </button>
    </div>
  );
}
