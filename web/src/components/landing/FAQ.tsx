'use client';

import { useState } from 'react';

const faqs = [
  {
    question: 'How do I recover my deposits?',
    answer: 'Your wallet is your recovery key. Reconnect the same wallet on any browser or device and your private balances reappear automatically. Notes are encrypted with a key derived from your wallet signature and stored on-chain — no files to back up, no passwords to remember. The only thing you need to protect is your wallet seed phrase.',
  },
  {
    question: 'How fast are deposits and withdrawals?',
    answer: 'Deposits confirm in under a second (Solana finality). Withdrawals generate a proof locally in a few seconds, and the on-chain verification completes in under half a second. Large withdrawals are pipelined automatically.',
  },
  {
    question: 'Can I deposit any amount?',
    answer: 'Yes. Enter any amount starting from 0.1 SOL and ZeroK automatically handles the privacy math behind the scenes. You just enter the number and approve — usually a single wallet popup, even for larger amounts.',
  },
  {
    question: 'Is ZeroK open-source?',
    answer: 'Yes. All smart contracts, zero-knowledge circuits, and frontend code are open-source and publicly available for independent review. You don\'t have to trust us — you can verify the code yourself.',
  },
  {
    question: 'What could theoretically leak my privacy?',
    answer: 'Timing correlation: if you deposit and withdraw too quickly, or at unusual times, an observer might correlate the transactions. Best practice: wait for other deposits to enter the pool before withdrawing, and always use a fresh recipient address. The larger the anonymity set, the stronger your privacy.',
  },
  {
    question: 'How does this compare to other privacy protocols?',
    answer: 'ZeroK uses industry-standard cryptography (Groth16 proofs, Merkle trees, Poseidon hashes) and is built natively for Solana. This means faster finality, lower fees, and a user experience optimized for Solana wallets — with wallet-derived recovery that no other privacy protocol on Solana currently offers.',
  },
  {
    question: 'Can I withdraw without paying gas?',
    answer: 'Yes. ZeroK features protocol-powered withdrawals where the protocol submits your transaction and covers all network fees automatically. A small 0.3% protocol fee is deducted from your withdrawal amount. The recipient wallet never needs any SOL — it can be completely empty.',
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
