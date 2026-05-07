let openModalCount = 0;

export function isAnyModalOpen(): boolean {
  return openModalCount > 0;
}

export function incrementOpenModalCount(): number {
  openModalCount += 1;
  return openModalCount;
}

export function decrementOpenModalCount(): number {
  openModalCount = Math.max(0, openModalCount - 1);
  return openModalCount;
}
