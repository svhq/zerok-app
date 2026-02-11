import React from 'react'
import type { DocsThemeConfig } from 'nextra-theme-docs'

const config: DocsThemeConfig = {
  logo: (
    <span style={{ fontWeight: 700, fontSize: '1.25rem' }}>
      <span style={{ color: '#14B8A6' }}>Zero</span>
      <span style={{ color: '#E5E7EB' }}>K</span>
      <span style={{ color: '#9CA3AF', fontWeight: 400, fontSize: '0.875rem', marginLeft: '0.5rem' }}>
        Docs
      </span>
    </span>
  ),
  project: {
    link: 'https://zerok.app',
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        <path d="M9 12l2 2 4-4" />
      </svg>
    ),
  },
  docsRepositoryBase: 'https://github.com/zerok-protocol/docs',
  head: (
    <>
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <meta name="description" content="ZeroK Documentation - Privacy-preserving protocol for Solana" />
      <meta property="og:title" content="ZeroK Docs" />
      <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🛡</text></svg>" />
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
    </>
  ),
  color: {
    hue: 168,
    saturation: 74,
  },
  navigation: {
    prev: true,
    next: true,
  },
  sidebar: {
    defaultMenuCollapseLevel: 1,
    toggleButton: true,
  },
  toc: {
    backToTop: true,
  },
  editLink: {
    component: null,
  },
  feedback: {
    content: null,
  },
  footer: {
    content: (
      <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center' }}>
        <span>
          {new Date().getFullYear()} ZeroK Protocol. All rights reserved.
        </span>
        <div style={{ display: 'flex', gap: '1.5rem' }}>
          <a href="https://zerok.app" target="_blank" rel="noopener noreferrer" style={{ color: '#14B8A6' }}>
            Launch App
          </a>
          <a href="https://github.com/svhq/zerok-app" target="_blank" rel="noopener noreferrer" style={{ color: '#9CA3AF' }}>
            GitHub
          </a>
        </div>
      </div>
    ),
  },
  darkMode: false,
  nextThemes: {
    defaultTheme: 'dark',
    forcedTheme: 'dark',
  },
}

export default config
