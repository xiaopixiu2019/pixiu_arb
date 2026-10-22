import { useLanguage } from './i18n.js';
import { EXECUTION_PAGE_SIZE, executionPageWindow } from './execution-pagination.js';

export function ExecutionPagination({ itemCount, page, onPageChange }: { itemCount: number; page: number; onPageChange: (page: number) => void }) {
  const { t } = useLanguage();
  if (itemCount < EXECUTION_PAGE_SIZE) return null;
  const window = executionPageWindow(itemCount, page);
  return <div className="funding-pagination execution-pagination"><span className="page-range">{window.start + 1}–{window.end} / {itemCount}</span><div className="page-controls"><button onClick={() => onPageChange(window.page - 1)} disabled={window.page <= 1}>{t('Prev')}</button><span className="page-indicator">{t('Page')} {window.page} / {window.pageCount}</span><button onClick={() => onPageChange(window.page + 1)} disabled={window.page >= window.pageCount}>{t('Next')}</button></div><span className="page-size">{EXECUTION_PAGE_SIZE} {t('per page')}</span></div>;
}
