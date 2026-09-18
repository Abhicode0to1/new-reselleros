@echo off
REM ============================================================================
REM  Deploy the CURRENT laptop folder to the online test environment.
REM
REM  Usage:  deploy-test.cmd      (from the production folder, Command Prompt)
REM
REM  ── WHAT THIS DOES AND DOES NOT TOUCH ──────────────────────────────────────
REM  Sends: the source code in this folder, exactly as it sits — including work
REM         that is not committed to git. node_modules, .next and .env.local are
REM         excluded by .gcloudignore.
REM
REM  Does NOT touch: your local database, your local dev server, or the online
REM         database. Only the application code is replaced online. The test
REM         environment's data is its own and survives every deploy.
REM
REM  Nothing here runs on its own. Deploying is always something you type.
REM ============================================================================

setlocal
set PROJECT=boxwood-victor-453804-v4
set REGION=asia-south1
set SERVICE=reselleros-test
set IMAGE=%REGION%-docker.pkg.dev/%PROJECT%/resellerps/%SERVICE%:latest

echo.
echo === 1/2  Building on Google's machines (this folder is uploaded) ==========
call gcloud builds submit --config cloudbuild.test.yaml --project=%PROJECT%
if errorlevel 1 (
  echo.
  echo BUILD FAILED - nothing was deployed. The online app is untouched and still
  echo running the previous version. Fix the error above and run this again.
  exit /b 1
)

echo.
echo === 2/2  Putting it online ================================================
call gcloud run deploy %SERVICE% --image=%IMAGE% --region=%REGION% --project=%PROJECT%
if errorlevel 1 (
  echo.
  echo DEPLOY FAILED - the image built fine but could not be released. The online
  echo app is still running the previous version.
  exit /b 1
)

echo.
echo Done.  https://reselleros-test-1027476185726.asia-south1.run.app
endlocal
