export interface Detection {
  class_id: number;
  name: string;
  conf: number;
  xyxy: [number, number, number, number];
  model: string;
}

export interface YoloClass {
  id: number;
  name: string;
}

export interface SelectedYoloClass extends YoloClass {
  model: string;
  conf: number;
}

export interface AutoMeasurement {
  enabled: boolean;
  classes: SelectedYoloClass[];
}

export interface CustomWeightsStatus {
  name: string;
  uploaded_at: string;
  size_mb: number;
  class_count: number;
}

export interface WeightsStatus {
  preset_name: string;
  custom: CustomWeightsStatus | null;
}
