import os
import sys
import numpy as np
from PIL import Image

def make_white_transparent(input_path, output_path, low_threshold=230, high_threshold=250):
    print(f"Processing light mode image: {input_path}")
    img = Image.open(input_path).convert("RGBA")
    data = np.array(img, dtype=np.float32)

    # Extract RGB channels
    r, g, b = data[:, :, 0], data[:, :, 1], data[:, :, 2]
    # Brightness / minimum across channels
    min_val = np.minimum(np.minimum(r, g), b)

    # Distance to pure white
    white_dist = np.sqrt((255.0 - r)**2 + (255.0 - g)**2 + (255.0 - b)**2)

    # Alpha calculation
    alpha = np.zeros_like(r)
    # High distance from white -> fully opaque
    opaque_mask = white_dist > 45.0
    alpha[opaque_mask] = 255.0

    # Smooth transition region
    trans_mask = (white_dist >= 12.0) & (white_dist <= 45.0)
    alpha[trans_mask] = ((white_dist[trans_mask] - 12.0) / (45.0 - 12.0)) * 255.0

    # Pure white background
    pure_white = white_dist < 12.0
    alpha[pure_white] = 0.0

    data[:, :, 3] = np.clip(alpha, 0, 255)
    result = Image.fromarray(data.astype(np.uint8), "RGBA")
    result.save(output_path, "PNG")
    print(f"Saved transparent light image: {output_path} ({os.path.getsize(output_path)} bytes)")

def make_dark_transparent(input_path, output_path, inner_dist=18.0, outer_dist=42.0):
    print(f"Processing dark mode image: {input_path}")
    img = Image.open(input_path).convert("RGBA")
    data = np.array(img, dtype=np.float32)

    # Sample the 4 corners to find exact background color
    h, w, _ = data.shape
    corner_samples = [
        data[2:8, 2:8, :3],
        data[2:8, w-8:w-2, :3],
        data[h-8:h-2, 2:8, :3],
        data[h-8:h-2, w-8:w-2, :3],
    ]
    bg_color = np.median(np.concatenate([c.reshape(-1, 3) for c in corner_samples]), axis=0)
    print(f"Detected dark background color: RGB({bg_color[0]:.1f}, {bg_color[1]:.1f}, {bg_color[2]:.1f})")

    r, g, b = data[:, :, 0], data[:, :, 1], data[:, :, 2]
    dist = np.sqrt((r - bg_color[0])**2 + (g - bg_color[1])**2 + (b - bg_color[2])**2)

    alpha = np.zeros_like(r)
    # Beyond outer_dist -> fully opaque
    alpha[dist >= outer_dist] = 255.0

    # Smooth transition
    trans_mask = (dist > inner_dist) & (dist < outer_dist)
    alpha[trans_mask] = ((dist[trans_mask] - inner_dist) / (outer_dist - inner_dist)) * 255.0

    # Inner background -> transparent
    alpha[dist <= inner_dist] = 0.0

    data[:, :, 3] = np.clip(alpha, 0, 255)
    result = Image.fromarray(data.astype(np.uint8), "RGBA")
    result.save(output_path, "PNG")
    print(f"Saved transparent dark image: {output_path} ({os.path.getsize(output_path)} bytes)")

def main():
    assets_dir = os.path.join(os.path.dirname(__file__), "src", "assets")
    
    # 1. Light Mode Icons
    light_in = os.path.join(assets_dir, "switch-icons-light.jpg")
    light_out = os.path.join(assets_dir, "switch-icons-light.png")
    if os.path.exists(light_in):
        make_white_transparent(light_in, light_out)

    # 2. Dark Mode Icons
    dark_in = os.path.join(assets_dir, "switch-icons-dark.jpg")
    dark_out = os.path.join(assets_dir, "switch-icons-dark.png")
    if os.path.exists(dark_in):
        make_dark_transparent(dark_in, dark_out)

    # 3. Browser Icons Sprite
    browser_in = os.path.join(assets_dir, "browsers-sprite.jpg")
    browser_out = os.path.join(assets_dir, "browsers-sprite.png")
    if os.path.exists(browser_in):
        make_dark_transparent(browser_in, browser_out, inner_dist=15.0, outer_dist=38.0)

if __name__ == "__main__":
    main()
