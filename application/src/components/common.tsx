import { Alert, Empty as ArcoEmpty, Tag } from '@arco-design/web-react';
import { type ReactNode, useEffect, useRef } from 'react';

import { busyStates, labels } from '../domain';
import { BranchIcon, ProjectsIcon } from '../icons';

export function Status({ state = 'none', children }: { state?: string; children?: ReactNode }) {
  const color =
    state === 'ready' ? 'green' : state === 'failed' ? 'orange' : busyStates.has(state) ? 'arcoblue' : undefined;
  return (
    <Tag color={color} size='small'>
      {children || labels[state] || state}
    </Tag>
  );
}
export function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, [title]);
  return (
    <header className='page-heading'>
      <div>
        {eyebrow && <div className='eyebrow'>{eyebrow}</div>}
        <h1 ref={heading} tabIndex={-1}>
          {title}
        </h1>
        {description && <p>{description}</p>}
      </div>
      {action && <div className='heading-action'>{action}</div>}
    </header>
  );
}
export function Empty({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <ArcoEmpty
      className='empty-state'
      icon={<ProjectsIcon className='empty-icon' />}
      description={
        <>
          <h2>{title}</h2>
          <p>{children}</p>
          {action}
        </>
      }
    />
  );
}
export function Callout({
  title,
  children,
  action,
  tone = 'info',
}: {
  title?: string;
  children: ReactNode;
  action?: ReactNode;
  tone?: 'info' | 'warning' | 'success';
}) {
  return (
    <Alert
      className='callout'
      type={tone}
      title={title}
      showIcon
      content={
        <div className='banner-content'>
          <span>{children}</span>
          {action}
        </div>
      }
    />
  );
}
export function ProjectMark({ name, small = false }: { name: string; small?: boolean }) {
  return (
    <span aria-hidden='true' className={`project-mark ${small ? 'small' : ''}`}>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}
export function Branch({ value }: { value: string }) {
  return (
    <span className='branch' title={value}>
      <BranchIcon />
      {value}
    </span>
  );
}
export function Definition({ entries }: { entries: [string, ReactNode][] }) {
  return (
    <dl className='definition'>
      {entries.map(([key, value]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
