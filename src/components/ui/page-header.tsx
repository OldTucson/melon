import clsx from "clsx";

export function PageHeader({
  actions,
  className,
  description,
  eyebrow,
  id,
  title,
}: {
  actions?: React.ReactNode;
  className?: string;
  description?: React.ReactNode;
  eyebrow?: React.ReactNode;
  id?: string;
  title: React.ReactNode;
}) {
  return (
    <header className={clsx("page-header", className)}>
      <div className="page-header-copy">
        {eyebrow ? <p className="page-eyebrow">{eyebrow}</p> : null}
        <h1 id={id}>{title}</h1>
        {description ? (
          <div className="page-description">{description}</div>
        ) : null}
      </div>
      {actions ? <div className="page-header-actions">{actions}</div> : null}
    </header>
  );
}
