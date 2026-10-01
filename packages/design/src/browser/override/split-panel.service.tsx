import { FunctionComponentElement, ReactNode } from 'react';

import { SplitPanelProps } from '@opensumi/ide-core-browser/components';
import { SplitPanelService } from '@opensumi/ide-core-browser/components/layout';

export class DesignSplitPanelService extends SplitPanelService {
  override renderSplitPanel(
    component: JSX.Element,
    children: ReactNode[],
    props: SplitPanelProps,
  ): FunctionComponentElement<any> {
    return super.renderSplitPanel(component, children, props);
  }

  override interceptProps(props: SplitPanelProps): SplitPanelProps {
    return props;
  }
}
