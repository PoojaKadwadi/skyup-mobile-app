if(NOT TARGET hermes-engine::libhermes)
add_library(hermes-engine::libhermes SHARED IMPORTED)
set_target_properties(hermes-engine::libhermes PROPERTIES
    IMPORTED_LOCATION "C:/Users/POOJA/.gradle/caches/transforms-4/2e275338e51bd5b84054bdbe01b95993/transformed/hermes-android-0.73.6-debug/prefab/modules/libhermes/libs/android.x86/libhermes.so"
    INTERFACE_INCLUDE_DIRECTORIES "C:/Users/POOJA/.gradle/caches/transforms-4/2e275338e51bd5b84054bdbe01b95993/transformed/hermes-android-0.73.6-debug/prefab/modules/libhermes/include"
    INTERFACE_LINK_LIBRARIES ""
)
endif()

