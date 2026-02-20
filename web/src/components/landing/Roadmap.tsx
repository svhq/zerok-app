'use client';

const roadmapItems = [
  {
    phase: 'Now',
    status: 'active',
    title: 'Core Protocol',
    items: [
      'Fixed-denomination vaults (1, 10, 100, 1000 SOL)',
      'Browser-based proof generation',
      'On-chain Groth16 verification',
      'Self-custodial note management',
      'Protocol support for gas-free withdrawals',
    ],
  },
  {
    phase: 'Next',
    status: 'upcoming',
    title: 'Enhanced UX',
    items: [
      'Multi-chain deployment (Ethereum, BNB Chain, and more)',
      'Private swaps',
      'Multi-token support (USDC, popular SPL tokens)',
      'Improved proof generation performance',
      'Mobile-optimized experience',
    ],
  },
  {
    phase: 'Future',
    status: 'planned',
    title: 'Advanced Features',
    items: [
      'Cross-chain privacy bridges',
      'Selective disclosure proofs',
      'Compliance-compatible withdrawal options',
      'SDK for protocol integrations',
    ],
  },
];

export default function Roadmap() {
  return (
    <section id="roadmap" className="landing-section">
      <div className="text-center mb-12">
        <span className="tech-chip mb-4 inline-block">Roadmap</span>
        <h2 className="landing-h2 text-zk-text mb-4">
          What&apos;s coming
        </h2>
        <p className="text-zk-text-muted max-w-2xl mx-auto">
          ZeroK is evolving. Here&apos;s where we&apos;re headed.
        </p>
      </div>

      <div className="grid md:grid-cols-3 gap-6 max-w-5xl mx-auto">
        {roadmapItems.map((phase) => (
          <div
            key={phase.phase}
            className={`landing-card relative ${
              phase.status === 'active' ? 'border-zk-teal/40' : ''
            }`}
          >
            {/* Phase Badge */}
            <div className="flex items-center justify-between mb-4">
              <span
                className={`px-3 py-1 rounded-full text-xs font-semibold ${
                  phase.status === 'active'
                    ? 'bg-zk-teal/20 text-zk-teal'
                    : phase.status === 'upcoming'
                    ? 'bg-zk-surface text-zk-text-muted'
                    : 'bg-zk-surface text-zk-text-muted'
                }`}
              >
                {phase.phase}
              </span>
              {phase.status === 'active' && (
                <span className="flex items-center gap-1.5 text-xs text-zk-teal">
                  <span className="w-2 h-2 rounded-full bg-zk-teal animate-pulse" />
                  Live
                </span>
              )}
            </div>

            {/* Title */}
            <h3 className="text-lg font-semibold text-zk-text mb-4">{phase.title}</h3>

            {/* Items */}
            <ul className="space-y-2">
              {phase.items.map((item, index) => (
                <li key={index} className="flex items-start gap-2 text-sm">
                  <svg
                    className={`w-4 h-4 mt-0.5 flex-shrink-0 ${
                      phase.status === 'active' ? 'text-zk-teal' : 'text-zk-text-muted'
                    }`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    {phase.status === 'active' ? (
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    ) : (
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    )}
                  </svg>
                  <span className="text-zk-text-muted">{item}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
