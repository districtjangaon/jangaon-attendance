/**
 * Main.gs — HTTP entry points and routing.
 *
 * All POST bodies are JSON sent as Content-Type text/plain (a CORS "simple
 * request", so the browser never preflights — Apps Script web apps cannot
 * answer OPTIONS). The session token travels in the body, never in a header.
 */

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOut_({ ok: false, code: 'BAD_JSON' });
  }
  try {
    const action = String(req.action || '');
    if (action === 'ping') return jsonOut_({ ok: true, ts: nowIso_() });
    if (action === 'login') return jsonOut_(apiLogin_(req));
    if (action === 'diag') return jsonOut_(apiDiag_(req)); // DIAG_KEY-gated, read-only

    // Everything else requires a valid session token.
    const auth = verifyToken_(req.token);
    if (!auth.ok) return jsonOut_(auth);

    const ROUTES = {
      // field app
      sync: apiSync_,
      config: apiConfig_,
      myHistory: apiMyHistory_,
      logout: apiLogout_,
      leaveApply: apiLeaveApply_,
      myLeaves: apiMyLeaves_,
      leaveBalance: apiLeaveBalance_,
      myIssues: apiMyIssues_,
      resolveIssue: apiResolveIssue_,
      appMode: apiAppMode_,
      seenPing: apiSeenPing_,
      // console (supervisor/cdpo/admin)
      nameMap: apiNameMap_,
      correction: apiCorrection_,
      leaveList: apiLeaveList_,
      leaveRegister: apiLeaveRegister_,
      mapDay: apiMapDay_,
      reviewFinding: apiReviewFinding_,
      reviewList: apiReviewList_,
      leaveDecide: apiLeaveDecide_,
      leaveDecideBulk: apiLeaveDecideBulk_,
      leaveDedupe: apiLeaveDedupe_,
      pinReset: apiPinReset_,
      deviceUnbind: apiDeviceUnbind_,
      setAwcCoords: apiSetAwcCoords_,
      raiseIssue: apiRaiseIssue_,
      listIssues: apiListIssues_,
      closeIssue: apiCloseIssue_,
      // console (admin)
      userUpsert: apiUserUpsert_,
      setLeaveApprover: apiSetLeaveApprover_,
      importUsers: apiImportUsers_,
      setSchedules: apiSetSchedules_,
      testReset: apiTestReset_,
      revoke: apiRevoke_
    };
    const fn = ROUTES[action];
    if (!fn) return jsonOut_({ ok: false, code: 'NO_ACTION' });
    return jsonOut_(fn(auth, req));
  } catch (err) {
    return jsonOut_({ ok: false, code: 'ERR', msg: String((err && err.message) || err) });
  }
}

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || '';
  try {
    if (action === 'ping') return jsonOut_({ ok: true, ts: nowIso_() });
    if (action === 'photo') return apiPhoto_(e.parameter);
    return jsonOut_({ ok: true, service: 'attendance-backend', ts: nowIso_() });
  } catch (err) {
    return jsonOut_({ ok: false, code: 'ERR', msg: String((err && err.message) || err) });
  }
}
