'use client';

import { useState } from 'react';

const faqs = [
  {
    question: 'What happens if I lose my note?',
    answer: 'Your funds become permanently unrecoverable. The note contains the cryptographic secrets needed to generate a valid withdrawal proof. There is no recovery mechanism — this is the tradeoff for true self-custody. Always backup your note securely, ideally in multiple locations.',
  },
  {
    question: 'How fast are deposits and withdrawals?',
    answer: 'Deposits confirm in under a second (Solana finality). Withdrawals require ~20-30 seconds of local proof generation in your browser, then the on-chain verification completes in ~400ms. The proof generation time depends on your device\'s computing power.',
  },
  {
    question: 'Why fixed pool sizes? Can\'t I deposit any amount?',
    answer: 'Fixed denominations (0.001, 0.1, 1 SOL) maximize privacy by ensuring all deposits in a pool look identical. If you could deposit arbitrary amounts, the specific amount itself would be a fingerprint. This is a deliberate privacy-vs-flexibility tradeoff.',
  },
  {
    question: 'Is ZeroK open-source?',
    answer: 'Yes. ZeroK\'s circuits and frontend are open source and available on GitHub for independent review. The protocol interface and documentation are publicly available.',
  },
  {
    question: 'What could theoretically leak my privacy?',
    answer: 'Timing correlation: if you deposit and withdraw too quickly, or at unusual times, an observer might correlate the transactions. Best practice: wait for other deposits to enter the pool before withdrawing. The larger the anonymity set, the stronger your privacy.',
  },
  {
    question: 'How does this compare to other privacy protocols?',
    answer: 'ZeroK uses industry-standard cryptography (Groth16 proofs, Merkle trees, Poseidon hashes) and is built natively for Solana. This means faster finality, lower fees, and a user experience optimized for Solana wallets.',
  },
  {
    question: 'Can I withdraw without paying gas?',
    answer: 'Yes! ZeroK features protocol-powered withdrawals where the protocol handles your transaction and pays all network fees automatically. A small 0.3% protocol fee is deducted from your withdrawal amount. You never need SOL in your recipient wallet.',
  },
];

export default function FAQ() {
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  return (
    <section id="faq" className="landing-section bg-zk-surface/30">
      <div className="max-w-3xl mx-auto">
        <div className="text-center mb-12">
          <span className="tech-chip mb-4 inline-block">FAQ</span>
          <h2 className="landing-h2 text-zk-text mb-4">
            Common questions
          </h2>
          <p className="text-zk-text-muted max-w-2xl mx-auto">
            Everything you need to know about ZeroK, including the honest tradeoffs.
          </p>
        </div>

        {/* FAQ Accordion */}
        <div className="space-y-3">
          {faqs.map((faq, index) => (
            <div
              key={index}
              className="border border-zk-border rounded-xl overflow-hidden"
            >
              <button
                onClick={() => setOpenIndex(openIndex === index ? null : index)}
                className="w-full px-6 py-4 text-left flex items-center justify-between bg-zk-surface/30 hover:bg-zk-surface/50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-zk-teal focus-visible:ring-inset"
                aria-expanded={openIndex === index}
                aria-controls={`faq-answer-${index}`}
              >
                <span className="font-medium text-zk-text pr-4">{faq.question}</span>
                <svg
                  className={`w-5 h-5 text-zk-text-muted flex-shrink-0 transition-transform duration-200 ${
                    openIndex === index ? 'rotate-180' : ''
                  }`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              <div
                id={`faq-answer-${index}`}
                role="region"
                aria-labelledby={`faq-question-${index}`}
                className={`overflow-hidden transition-all duration-300 ${
                  openIndex === index ? 'max-h-96' : 'max-h-0'
                }`}
              >
                <div className="px-6 py-4 bg-zk-bg/30">
                  <p className="text-zk-text-muted text-sm leading-relaxed">{faq.answer}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
