import { PageHead, Panel } from '../components/ui';

const QUESTIONS_DOC = 'https://docs.google.com/document/d/1QFxUWk99y6MplLBdimdErCAo8WE1ncCgEm5KIsDBbmk/edit';

export function Finance() {
  return (
    <>
      <PageHead kicker="Finance" title="Guarantees, bank limits and margin money" sub="This module is designed but not yet built." />
      <Panel>
        <div className="stack">
          <p style={{ margin: 0 }}>
            This screen will track bank guarantees given to manufacturers, running-finance and other bank limits, margin money held against each
            guarantee, mark-up accruals and company order (CO) payments, and show how much buying power is left on any day.
          </p>
          <p style={{ margin: 0 }}>
            The ledger already has the accounts these will post to (margin money, bank borrowings, mark-up expense). The rules for how
            guarantees are drawn down, released and renewed come from the finance team's answers to the questionnaire.
          </p>
          <div className="note note-amber">
            Waiting on: answers to the finance section of the <a href={QUESTIONS_DOC} target="_blank" rel="noreferrer">questionnaire</a>.
          </div>
        </div>
      </Panel>
    </>
  );
}
