'use client';

const problems = [
  {
    icon: 'eye',
    title: 'Total Transparency',
    description: 'Every blockchain transaction is permanently public. Anyone can see your entire financial history.',
  },
  {
    icon: 'target',
    title: 'Wallet Tracking',
    description: 'High-value wallets are constantly monitored. Your holdings and movements are always visible.',
  },
  {
    icon: 'alert',
    title: 'Targeted Attacks',
    description: 'Public wealth attracts unwanted attention. Price manipulation and targeted scams become easier.',
  },
];

export default function Problem() {
  return (
    <section id="problem" className="landing-section">
      <div className="text-center mb-16">
        <span className="tech-chip mb-4 inline-block">The Problem</span>
        <h2 className="landing-h2 text-zk-text mb-4">
          On-chain transparency is a double-edged sword
        </h2>
        <p className="text-zk-text-muted max-w-2xl mx-auto">
          Blockchain&apos;s openness enables trust, but it also exposes your financial privacy to everyone.
        </p>
      </div>

      <div className="grid md:grid-cols-3 gap-6">
        {problems.map((problem) => (
          <div key={problem.title} className="landing-card text-center">
            <div className="w-14 h-14 mx-auto mb-6 rounded-xl bg-zk-danger/10 flex items-center justify-center">
              {problem.icon === 'eye' && (
                <svg className="w-7 h-7 text-zk-danger" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
              )}
              {problem.icon === 'target' && (
                <svg className="w-7 h-7 text-zk-danger" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
                </svg>
              )}
              {problem.icon === 'alert' && (
                <svg className="w-7 h-7 text-zk-danger" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              )}
            </div>
            <h3 className="text-lg font-semibold text-zk-text mb-3">{problem.title}</h3>
            <p className="text-zk-text-muted text-sm">{problem.description}</p>
          </div>
        ))}
      </div>

      <div className="mt-12 text-center">
        <p className="text-zk-teal font-medium">
          ZeroK breaks the on-chain link using zero-knowledge cryptography.
        </p>
      </div>
    </section>
  );
}
