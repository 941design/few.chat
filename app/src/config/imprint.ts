/**
 * Legal provider identification for the German-law Impressum (§5 DDG, formerly
 * §5 TMG; register data per §35a GmbHG). The values here are language-neutral
 * legal facts — only the surrounding labels/headings are translated (i18n.ts).
 *
 * Empty string means "not yet supplied / not applicable" and the field is
 * omitted from the rendered Impressum.
 */
export const IMPRINT = {
  companyName: 'rotheric GmbH',
  street: 'Scheibenstr. 6a',
  city: '92637 Weiden in der Oberpfalz',
  country: 'Deutschland',

  // §5 (1) Nr. 1 DDG: authorized representative(s) of the GmbH.
  // REQUIRED — must name the managing director(s) (Geschäftsführer).
  managingDirectors: ['Markus Rother'] as string[],

  // §5 (1) Nr. 2 DDG: information enabling quick electronic contact.
  // Email is REQUIRED; phone is recommended but optional.
  email: 'markus@rotheric.com',
  phone: '',

  // §5 (1) Nr. 4 DDG / §35a GmbHG: commercial register.
  registerCourt: 'Amtsgericht Weiden',
  registerNumber: 'HRB 6782',

  // §5 (1) Nr. 6 DDG / §27a UStG: VAT identification number.
  // REQUIRED only if the company has been issued one; omit otherwise.
  vatId: 'DE463560219',
};
