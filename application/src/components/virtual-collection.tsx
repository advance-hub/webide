import { Table, type TableProps } from '@arco-design/web-react';

// Arco owns row virtualization, column alignment and scroll synchronization.
// A changed filter resets scrolling without clearing the URL's filter state.
export function VirtualTable<T extends object>({
  data = [],
  resetKey = '',
  rowHeight = 64,
  ...props
}: TableProps<T> & { resetKey?: string; rowHeight?: number }) {
  return (
    <div className='virtual-table' data-total={data.length}>
      <Table<T>
        key={resetKey}
        {...props}
        data={data}
        border={false}
        tableLayoutFixed
        pagination={false}
        virtualized={data.length > 40}
        virtualListProps={{ itemHeight: rowHeight, threshold: 1 }}
        scroll={{ ...props.scroll, y: data.length > 8 ? 520 : undefined }}
      />
    </div>
  );
}
