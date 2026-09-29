// info: an entry of pageInfo. The action button is omitted when the page has no action.
export function PageHeading({ info, onAction }) {
  return (
    <section className="heading">
      <div>
        <p className="eyebrow">{info.eyebrow}</p>
        <h1>{info.title}</h1>
        <p className="muted">{info.description}</p>
      </div>
      {info.action && <button type="button" className="primary" onClick={onAction}>{info.action}</button>}
    </section>
  );
}
