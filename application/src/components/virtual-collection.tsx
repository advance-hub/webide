import { Table, type TableProps } from '@arco-design/web-react';

// Arco 负责行虚拟化、列对齐和滚动同步。
// 筛选改变时重置滚动位置，保留 URL 中的筛选状态。
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
