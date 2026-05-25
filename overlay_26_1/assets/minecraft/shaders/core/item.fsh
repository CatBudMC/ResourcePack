#version 330

// Override of vanilla item.fsh. Discards fragments whose raw vertex tint
// is exactly the player-doll invisible-overlay sentinel 0x010203. Vanilla
// items don't tint with this value, so the discard is a no-op for them.

#moj_import <minecraft:fog.glsl>
#moj_import <minecraft:dynamictransforms.glsl>

uniform sampler2D Sampler0;

in float sphericalVertexDistance;
in float cylindricalVertexDistance;
in vec4 vertexColor;
in vec2 texCoord0;
in vec4 vertexColorRaw;

out vec4 fragColor;

void main() {
    {
        ivec3 s = ivec3(round(vertexColorRaw.rgb * 255.0));
        if (s == ivec3(1, 2, 3)) discard;
    }
    vec4 color = texture(Sampler0, texCoord0);
#ifdef ALPHA_CUTOUT
    if (color.a < ALPHA_CUTOUT) discard;
#endif
    color *= vertexColor * ColorModulator;
    fragColor = apply_fog(color, sphericalVertexDistance, cylindricalVertexDistance, FogEnvironmentalStart, FogEnvironmentalEnd, FogRenderDistanceStart, FogRenderDistanceEnd, FogColor);
}
