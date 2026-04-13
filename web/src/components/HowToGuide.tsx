interface HowToGuideProps {
  mode: 'deposit' | 'withdraw';
}

export default function HowToGuide({ mode }: HowToGuideProps) {
  const depositSteps = [
    { title: 'Enter amount', desc: 'Any amount from 0.1 SOL' },
    { title: 'Approve', desc: 'Single wallet popup' },
    { title: 'Done', desc: 'Notes auto-saved to your wallet' },
  ];

  const withdrawSteps = [
    { title: 'Connect wallet', desc: 'Notes appear automatically' },
    { title: 'Enter recipient', desc: 'Any wallet address' },
    { title: 'Generate proof', desc: 'A few seconds' },
    { title: 'Confirm', desc: 'SOL sent to recipient' },
  ];

  const steps = mode === 'deposit' ? depositSteps : withdrawSteps;

  return (
    <div className="hidden 2xl:block absolute left-0 -translate-x-full -ml-8 top-8 w-40 text-xs">
      <div className="sticky top-28">
        <h4 className="text-zk-text-muted font-medium mb-3 text-[11px] uppercase tracking-wider">
          How to {mode === 'deposit' ? 'Deposit' : 'Withdraw'}
        </h4>
        <ol className="space-y-2">
          {steps.map((step, i) => (
            <li key={i} className="flex gap-2">
              <span className="text-zk-teal/60 font-medium">{i + 1}.</span>
              <div>
                <span className="text-zk-text-muted">{step.title}</span>
                <span className="text-zk-text-muted/60"> — {step.desc}</span>
              </div>
            </li>
          ))}
        </ol>
        {mode === 'deposit' && (
          <p className="mt-4 text-[10px] text-zk-text-muted/50 leading-relaxed">
            Keep your note files safe — they're the only way to withdraw.
          </p>
        )}
      </div>
    </div>
  );
}
