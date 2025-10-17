import type { Unit } from "./store";

const CM_PER_INCH = 2.54;

export const convertHeight = (height: number, from: Unit, to: Unit): number => {
  if (Number.isNaN(height)) {
    return NaN;
  }

  if (from === to) {
    return height;
  }

  return from === "cm" ? height / CM_PER_INCH : height * CM_PER_INCH;
};

export const formatHeight = (
  height: number | null | undefined,
  unit: Unit,
  fractionDigits = 1
): string => {
  if (height === null || typeof height === "undefined" || Number.isNaN(height)) {
    return "--";
  }

  const value = unit === "cm" ? height : convertHeight(height, "cm", "inch");
  return `${value.toFixed(fractionDigits)} ${unit}`;
};

export const formatSpeed = (speed: number | null | undefined): string => {
  if (speed === null || typeof speed === "undefined" || Number.isNaN(speed)) {
    return "--";
  }

  const speedInMm = speed * 10;
  return `${speedInMm.toFixed(0)} mm/s`;
};
