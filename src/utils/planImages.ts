import litePlanImg from '../assets/images/plan_lite_box_1788334553835.jpg';
import proPlanImg from '../assets/images/plan_pro_box_1788334576855.jpg';
import corePlanImg from '../assets/images/plan_core_box_1788334595895.jpg';
import ultimatePlanImg from '../assets/images/plan_ultimate_box_1788334618338.jpg';

export const PLAN_IMAGES: Record<string, string> = {
  lite: litePlanImg,
  core: corePlanImg,
  pro: proPlanImg,
  ultimate: ultimatePlanImg,
};

export function getPlanSlug(planNameOrTitle?: string): 'lite' | 'core' | 'pro' | 'ultimate' {
  if (!planNameOrTitle) return 'pro';
  const lower = String(planNameOrTitle).toLowerCase();
  if (lower.includes('lite')) return 'lite';
  if (lower.includes('core')) return 'core';
  if (lower.includes('ultimate')) return 'ultimate';
  if (lower.includes('pro')) return 'pro';
  return 'pro';
}

export function getPlanImage(planNameOrTitle?: string, fallbackUrl?: string): string {
  if (fallbackUrl && typeof fallbackUrl === 'string' && fallbackUrl.trim() !== '' && !fallbackUrl.includes('placeholder')) {
    return fallbackUrl;
  }
  const slug = getPlanSlug(planNameOrTitle);
  return PLAN_IMAGES[slug] || proPlanImg;
}
