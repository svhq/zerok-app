'use client';

import { useState } from 'react';

const coreSpecs = [
  { label: 'Proof System', value: 'Groth16 (BN254)', note: 'Battle-tested SNARK' },
  { label: 'Hash Function', value: 'Poseidon', note: 'ZK-optimized' },
  { label: 'Merkle Tree Depth', value: '20 levels', note: '~1M deposits per pool' },
  { label: 'Pool Sizes', value: '1, 10, 100 SOL', note: 'Fixed denominations' },
];

const performanceSpecs = [
  { label: 'Deposit Time', value: '< 1 second', note: 'Near-instant' },
  { label: 'Proof Generation', value: '~20-30 seconds', note: 'Client-side (browser)' },
  { label: 'On-chain Verification', value: '~400ms', note: 'Single transaction' },
  { label: 'Proof Size', value: '~256 bytes', note: 'Compact Groth16' },
];

const securitySpecs = [
  { label: 'Nullifier Scheme', value: 'Hash(secret, path)', note: 'Double-spend prevention' },
  { label: 'Commitment', value: 'Poseidon(secret, nullifier)', note: 'Hidden in Merkle tree' },
  { label: 'Trusted Setup', value: 'Powers of Tau', note: 'Community ceremony' },
  { label: 'Key Size', value: '~40 MB', note: 'Downloaded once' },
];

export default function Specs() {
  const [expandedSection, setExpandedSection] = useState<string | null>('core');

  const sections = [
    { id: 'core', title: 'Core Protocol', specs: coreSpecs },
    { id: 'performance', title: 'Performance', specs: performanceSpecs },
    { id: 'security', title: 'Security Parameters', specs: securitySpecs },
  ];

  return (
    <section id="specs" className="landing-section">
      <div className="max-w-4xl mx-auto">
        <div className="text-center mb-12">
          <span className="tech-chip mb-4 inline-block">Technical Specs</span>
          <h2 className="landing-h2 text-zk-text mb-4">
            For builders and skeptics
          </h2>
          <p className="text-zk-text-muted max-w-2xl mx-auto">
            The technical parameters that power ZeroK. Click to expand each section.
          </p>
        </div>

        {/* Accordion Sections */}
        <div className="space-y-4">
          {sections.map((section) => (
            <div
              key={section.id}
              className="border border-zk-border rounded-xl overflow-hidden"
            >
              {/* Section Header */}
              <button
                onClick={() => setExpandedSection(expandedSection === section.id ? null : section.id)}
                className="w-full px-6 py-4 flex items-center justify-between bg-zk-surface/50 hover:bg-zk-surface transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-zk-teal focus-visible:ring-inset"
                aria-expanded={expandedSection === section.id}
              >
                <span className="font-semibold text-zk-text">{section.title}</span>
                <svg
                  className={`w-5 h-5 text-zk-text-muted transition-transform duration-200 ${
                    expandedSection === section.id ? 'rotate-180' : ''
                  }`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              {/* Section Content */}
              <div
                className={`overflow-hidden transition-all duration-300 ${
                  expandedSection === section.id ? 'max-h-96' : 'max-h-0'
                }`}
              >
                <div className="px-6 py-4 bg-zk-bg/50">
                  <table className="w-full">
                    <tbody>
                      {section.specs.map((spec, index) => (
                        <tr
                          key={spec.label}
                          className={index !== section.specs.length - 1 ? 'border-b border-zk-border/50' : ''}
                        >
                          <td className="py-3 text-sm text-zk-text-muted">{spec.label}</td>
                          <td className="py-3 text-sm text-zk-text font-medium text-right">
                            {spec.value}
                            {spec.note && (
                              <span className="block text-xs text-zk-text-muted font-normal mt-0.5">
                                {spec.note}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Tech Chips */}
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <span className="tech-chip">Groth16</span>
          <span className="tech-chip">BN254</span>
          <span className="tech-chip">Poseidon</span>
          <span className="tech-chip">Merkle Trees</span>
        </div>
      </div>
    </section>
  );
}
