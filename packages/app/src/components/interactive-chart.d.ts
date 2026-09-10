import type { ReactElement } from "react";
import type { ChartFenceLanguage } from "./interactive-chart-fence";

export interface InteractiveChartProps {
  code: string;
  language: ChartFenceLanguage;
}

export declare function InteractiveChart(props: InteractiveChartProps): ReactElement;
