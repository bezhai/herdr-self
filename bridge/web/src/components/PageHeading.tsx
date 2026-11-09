import type { Page, pageInfo } from '../pages/pageInfo.ts';

// info: an entry of pageInfo. The action button is omitted when the page has no action.
export function PageHeading({ info, onAction }: { info: (typeof pageInfo)[Page], onAction?: () => void }) {
  return (
    <section className="heading">
      <h1>{info.title}</h1>
      {info.action && <button type="button" className="primary" onClick={onAction}>{info.action}</button>}
    </section>
  );
}
