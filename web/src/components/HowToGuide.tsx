interface HowToGuideProps {
  mode: 'deposit' | 'withdraw';
}

export default function HowToGuide({ mode }: HowToGuideProps) {
  const depositSteps = [
    { title: 'Select pool', desc: 'Select denomination' },
    { title: 'Set quantity', desc: 'How many notes' },
    { title: 'Deposit', desc: 'Approve wallet tx' },
    { title: 'Save notes', desc: 'Auto-downloads. Allow if prompted.' },
  ];

  const withdrawSteps = [
    { title: 'Import notes', desc: 'Drop or paste files' },
    { title: 'Select notes', desc: 'Check to withdraw' },
    { title: 'Enter recipient', desc: 'Any wallet address' },
    { title: 'Generate proof', desc: '~20-30 seconds' },
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
