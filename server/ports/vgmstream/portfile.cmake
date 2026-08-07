vcpkg_from_github(
    OUT_SOURCE_PATH SOURCE_PATH
    REPO vgmstream/vgmstream
    REF 4021c853ca5c7bc87de596a2c3b2e1b22bcdf45c
    SHA512 a6795f4125080abace1174b5f90005ca895731ace1f80cb6d9069e4815c4417a856f9da95f875c7ee70a4d4d28bd51b368db07f1dd053b593f90dcbba530a60f
    PATCHES install-static-library.patch
)

vcpkg_cmake_configure(
    SOURCE_PATH "${SOURCE_PATH}"
    OPTIONS
        -DBUILD_CLI=OFF
        -DBUILD_V123=OFF
        -DBUILD_AUDACIOUS=OFF
        -DBUILD_FB2K=OFF
        -DBUILD_WINAMP=OFF
        -DBUILD_XMPLAY=OFF
        -DBUILD_SHARED_LIBS=OFF
        -DUSE_MPEG=OFF
        -DUSE_VORBIS=OFF
        -DUSE_FFMPEG=OFF
        -DUSE_G719=OFF
        -DUSE_ATRAC9=OFF
        -DUSE_CELT=OFF
        -DUSE_SPEEX=OFF
        -DUSE_G7221=ON
)
vcpkg_cmake_install()

file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/include")
vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/COPYING")
