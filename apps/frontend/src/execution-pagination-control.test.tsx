import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ExecutionPagination } from './execution-pagination-control.js';
import { LanguageContext } from './i18n.js';

function render(itemCount: number): string {
  return renderToStaticMarkup(
    <LanguageContext.Provider value={{ language: 'en', theme: 'dark', t: (key) => key, setLanguage: vi.fn() }}>
      <ExecutionPagination itemCount={itemCount} page={1} onPageChange={vi.fn()} />
    </LanguageContext.Provider>,
  );
}

describe('ExecutionPagination', () => {
  it('hides the current page and controls when there are fewer than ten rows', () => {
    expect(render(0)).toBe('');
    expect(render(9)).toBe('');
  });

  it('keeps the controls at the requested ten-row boundary', () => {
    expect(render(10)).toContain('class="page-indicator"');
  });
});
