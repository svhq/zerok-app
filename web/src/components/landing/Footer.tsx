'use client';

import Link from 'next/link';

const footerLinks = {
  product: [
    { label: 'Launch App', href: 'https://devnet.zerok.app/app' },
    { label: 'How It Works', href: '#how-it-works' },
    { label: 'Specs', href: '#specs' },
  ],
  resources: [
    { label: 'Documentation', href: 'https://docs.zerok.app' },
    { label: 'FAQ', href: '#faq' },
  ],
  community: [
    { label: 'Twitter/X', href: '#' },
    { label: 'Discord', href: '#' },
  ],
};

export default function Footer() {
  return (
    <footer className="border-t border-zk-border bg-zk-surface/50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
          {/* Brand */}
          <div className="col-span-2 md:col-span-1">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-zk-teal to-zk-teal-light flex items-center justify-center">
                <svg
                  className="w-5 h-5 text-zk-bg"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"
                  />
                </svg>
              </div>
              <span className="text-xl font-bold text-zk-text">ZeroK</span>
            </div>
            <p className="text-sm text-zk-text-muted">
              Privacy-first, verified in zero-knowledge.
            </p>
          </div>

          {/* Product Links */}
          <div>
            <h4 className="font-semibold text-zk-text mb-4">Product</h4>
            <ul className="space-y-2">
              {footerLinks.product.map((link) => (
                <li key={link.label}>
                  <Link
                    href={link.href}
                    className="text-sm text-zk-text-muted hover:text-zk-teal transition-colors"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Resources Links */}
          <div>
            <h4 className="font-semibold text-zk-text mb-4">Resources</h4>
            <ul className="space-y-2">
              {footerLinks.resources.map((link) => (
                <li key={link.label}>
                  <Link
                    href={link.href}
                    className="text-sm text-zk-text-muted hover:text-zk-teal transition-colors"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Community Links */}
          <div>
            <h4 className="font-semibold text-zk-text mb-4">Community</h4>
            <ul className="space-y-2">
              {footerLinks.community.map((link) => (
                <li key={link.label}>
                  <a
                    href={link.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-zk-text-muted hover:text-zk-teal transition-colors inline-flex items-center gap-1"
                  >
                    {link.label}
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Bottom */}
        <div className="mt-12 pt-8 border-t border-zk-border flex flex-col md:flex-row justify-between items-center gap-4">
          <p className="text-sm text-zk-text-muted">
            {new Date().getFullYear()} ZeroK. Open-source privacy protocol.
          </p>
          <div className="flex items-center gap-4">
            <span className="tech-chip">Groth16</span>
            <span className="tech-chip">Poseidon</span>
          </div>
        </div>
      </div>
    </footer>
  );
}
