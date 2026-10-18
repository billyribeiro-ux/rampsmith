/**
 * The unsupported-attribute check graded by Sonnet 5.5 against the image and the title
 * (PLAN §13 "Evaluation harness"). Evaluation only; never runs on merchant traffic.
 */
import { buildParams, type PreparedCall } from '../calls.ts';
import { estimateTextTokens, imageTokens } from '../cost.ts';
import { imageBlock, validateImage, type ImageInput } from '../images.ts';
import type { GradeOutput } from '../outputs.ts';
import { prompt } from '../prompts.ts';
import { routeFor } from '../routing.ts';
import { encodeDataBlock, sanitizeUntrustedText, untrustedField } from '../untrusted.ts';
import type { GraderVerdict } from './metrics.ts';

export function prepareGrade(
  input: {
    readonly image: ImageInput;
    readonly productTitle: string;
    readonly productType: string;
    readonly alt: string;
  },
  options: { readonly tenantId: string },
): PreparedCall<GraderVerdict> {
  validateImage(input.image);
  const route = routeFor('grade_alt_text', { interactive: true });
  const p = prompt('grade-alt-text');
  const data = encodeDataBlock('merchant_data', {
    product_title: untrustedField(input.productTitle, 255),
    product_type: untrustedField(input.productType, 255),
  });
  const draft = encodeDataBlock('alt_text_under_review', {
    alt: sanitizeUntrustedText(input.alt, 300),
  });
  return {
    task: 'grade_alt_text',
    route,
    prompt: p,
    params: buildParams(
      route,
      p,
      [imageBlock(input.image), { type: 'text', text: `${data}\n${draft}` }],
      options.tenantId,
    ),
    estimatedInputTokens:
      imageTokens(input.image.width, input.image.height, route.model) +
      estimateTextTokens(p.text) +
      estimateTextTokens(`${data}${draft}`) +
      400,
    inputFlags: [],
    accept: (output) => {
      const o = output as GradeOutput;
      return {
        status: 'draft',
        value: { unsupported: o.unsupported_attributes, namesPerson: o.names_a_person },
        flags: o.instruction_like_text ? ['instruction_like_text_seen'] : [],
      };
    },
  };
}
