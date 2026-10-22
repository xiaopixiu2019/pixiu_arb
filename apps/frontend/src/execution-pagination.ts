export const EXECUTION_PAGE_SIZE = 10;

export type ExecutionPageWindow = {
  page: number;
  pageCount: number;
  start: number;
  end: number;
};

export function executionPageWindow(itemCount: number, requestedPage: number): ExecutionPageWindow {
  const safeItemCount = Math.max(0, Math.floor(itemCount));
  const pageCount = Math.max(1, Math.ceil(safeItemCount / EXECUTION_PAGE_SIZE));
  const page = Math.min(pageCount, Math.max(1, Math.floor(requestedPage) || 1));
  const start = (page - 1) * EXECUTION_PAGE_SIZE;
  return {
    page,
    pageCount,
    start,
    end: Math.min(start + EXECUTION_PAGE_SIZE, safeItemCount),
  };
}
