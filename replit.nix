{pkgs}: {
  deps = [
    pkgs.p7zip
    pkgs.osslsigncode
    pkgs.msitools
    pkgs.pkg-config
    pkgs.vips
  ];
}
