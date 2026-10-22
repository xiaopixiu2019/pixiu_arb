import { PUBLIC_PROMOTION } from '@gate-crossex/shared-types';
import { useLanguage } from './i18n.js';

export function PromotionLink() {
  const { t } = useLanguage();
  return <div className="promotion-disclosure">
    <a href={PUBLIC_PROMOTION.referralUrl} target="_blank" rel="noopener noreferrer">
      {t('Register on Gate · Enjoy trading-fee rebates')}
    </a>
    <small>{t('Gate settles eligible rebates. Existing accounts keep their current invitation relationship.')}</small>
  </div>;
}
