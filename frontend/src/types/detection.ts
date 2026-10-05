export interface Detection {
  class_id: number;
  name: string;
  conf: number;
  xyxy: [number, number, number, number];
  // lane id ("anchor" | "target")
  model: string;
}

export interface YoloClass {
  id: number;
  name: string;
}

export interface SelectedYoloClass extends YoloClass {
  // lane id ("anchor" | "target")
  model: string;
  conf: number;
}

export interface AutoMeasurement {
  enabled: boolean;
  classes: SelectedYoloClass[];
}

export interface LaneStatus {
  lane: string;
  source: "preset" | "upload";
  name: string;
  uploaded_at: string | null;
  size_mb: number | null;
  class_count: number;
}

export interface WeightsStatus {
  lanes: {
    anchor: LaneStatus;
    target: LaneStatus | null;
  };
}
