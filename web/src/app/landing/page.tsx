'use client';

import Header from '@/components/landing/Header';
import Footer from '@/components/landing/Footer';
import Hero from '@/components/landing/Hero';
import Problem from '@/components/landing/Problem';
import HowItWorks from '@/components/landing/HowItWorks';
import ValueBlocks from '@/components/landing/ValueBlocks';
import Trust from '@/components/landing/Trust';
import Specs from '@/components/landing/Specs';
import UseCases from '@/components/landing/UseCases';
import Roadmap from '@/components/landing/Roadmap';
import FAQ from '@/components/landing/FAQ';
import FinalCTA from '@/components/landing/FinalCTA';
import ScrollToTop from '@/components/landing/ScrollToTop';

export default function LandingPage() {
  return (
    <>
      <Header />

      <main>
        <Hero />
        <Problem />
        <HowItWorks />
        <ValueBlocks />
        <Trust />
        <Specs />
        <UseCases />
        <Roadmap />
        <FAQ />
        <FinalCTA />
      </main>

      <Footer />
      <ScrollToTop />
    </>
  );
}
