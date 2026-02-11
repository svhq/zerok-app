'use client';

const personas = [
  {
    title: 'Project Founders',
    icon: 'rocket',
    scenario: 'Move treasury funds without revealing wallet balances or transaction patterns to competitors.',
    benefit: 'Operational security for your project without sacrificing transparency where it matters.',
  },
  {
    title: 'High-Value Holders',
    icon: 'wallet',
    scenario: 'Protect significant holdings from targeted attacks, social engineering, and market manipulation.',
    benefit: 'Your portfolio size stays private. Move funds without painting a target.',
  },
  {
    title: 'DeFi Users',
    icon: 'refresh',
    scenario: 'Interact with protocols without revealing your full on-chain history and positions.',
    benefit: 'Compartmentalize your DeFi activity across wallets without creating obvious links.',
  },
  {
    title: 'Privacy Advocates',
    icon: 'eye-off',
    scenario: 'Exercise your right to financial privacy for legitimate personal transactions.',
    benefit: 'Not every transaction needs to be public. Some things are just your business.',
  },
];

export default function UseCases() {
  return (
    <section id="use-cases" className="landing-section bg-zk-surface/30">
      <div className="text-center mb-12">
        <span className="tech-chip mb-4 inline-block">Use Cases</span>
        <h2 className="landing-h2 text-zk-text mb-4">
          Who uses ZeroK?
        </h2>
        <p className="text-zk-text-muted max-w-2xl mx-auto">
          Privacy is a tool. Here&apos;s how different users put it to work.
        </p>
      </div>

      <div className="grid sm:grid-cols-2 gap-6 max-w-4xl mx-auto">
        {personas.map((persona) => (
          <div
            key={persona.title}
            className="landing-card hover:border-zk-teal/30 transition-colors"
          >
            {/* Header */}
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-lg bg-zk-teal/10 flex items-center justify-center">
                {persona.icon === 'rocket' && (
                  <svg className="w-5 h-5 text-zk-teal" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                )}
                {persona.icon === 'wallet' && (
                  <svg className="w-5 h-5 text-zk-teal" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
                  </svg>
                )}
                {persona.icon === 'refresh' && (
                  <svg className="w-5 h-5 text-zk-teal" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                )}
                {persona.icon === 'eye-off' && (
                  <svg className="w-5 h-5 text-zk-teal" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                  </svg>
                )}
              </div>
              <h3 className="text-lg font-semibold text-zk-text">{persona.title}</h3>
            </div>

            {/* Scenario */}
            <p className="text-zk-text-muted text-sm mb-4">{persona.scenario}</p>

            {/* Benefit */}
            <div className="pt-4 border-t border-zk-border">
              <p className="text-sm text-zk-teal">{persona.benefit}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
