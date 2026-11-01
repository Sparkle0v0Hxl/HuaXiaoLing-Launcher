@echo off
"%~dp0VelaEndfield.exe" -ParentExe "C:\Windows\notepad.exe" -GameExe "C:\nope.exe" -WorkDir "C:\Windows"
echo exit=%errorlevel%
"%~dp0VelaEndfield.exe" -ParentExe "C:\Windows\System32\cmd.exe" -GameExe "C:\nope.exe" -WorkDir "C:\Windows"
echo exit=%errorlevel%
