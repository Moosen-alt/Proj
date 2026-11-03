// WHO OWNS THIS CODE (#545). Keelix's source is proprietary and confidential (see LICENSE at
// the repo root). These two values are the one place the notice and the provenance id live:
//   - COPYRIGHT_NOTICE is printed at server start and carried as a `copyright` meta tag on
//     every frontend page;
//   - PROVENANCE_ID is a fixed, random id that means nothing on its own. It is logged at server
//     start and served as a `keelix-provenance` meta tag on every page, so a suspected copy
//     (its served pages, its logs, its source) can be checked for it. Never change it: its
//     value as evidence comes from appearing, unchanged, in Keelix's own dated history.
// backend/test/provenanceNotice.test.ts pins both against LICENSE, the package files and every
// frontend/*.html page, so a new page without them fails.

export const COPYRIGHT_NOTICE = "Copyright (c) 2026 Keelix. All rights reserved. Proprietary and confidential.";

export const PROVENANCE_ID = "kx-fcd3ffd4aa792bbd";
